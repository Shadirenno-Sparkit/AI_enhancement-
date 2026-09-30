import fs from 'node:fs/promises';
import path from 'node:path';
import type { InsightSegment, Job, TriageResult } from '@aiapp/shared';
import { INPUT_KIND_LABELS, PLATFORM_LABELS, resolvePlatform } from '@aiapp/shared';
import { config } from '../config.js';
import { analyze } from '../analysis/analyzer.js';
import { shouldAutoPlan, triage } from '../analysis/triage.js';
import { llm } from '../providers/llm.js';
import { buildLifeContext, proposeFacts } from '../repo/profile.js';
import {
  ensureJobFolder,
  jobFolder,
  renameJobFolder,
  writeInsights,
  writeSource,
  writeSpec,
  writeSummary,
  writeTranscript,
} from '../artifacts/fileManager.js';
import { fetchMedia } from '../ingestion/fetcher.js';
import { materializeSocialSession } from '../ingestion/social-auth.js';
import { normalize } from '../ingestion/normalizer.js';
import { runTranscriptWaterfall } from '../ingestion/transcript.js';
import { notifySpecReady } from '../notifications/notify.js';
import { audit } from '../repo/audit.js';
import { cacheGet, cacheSet, getInsightSourceByJob, saveInsightSource } from '../repo/insights.js';
import { addJobCost, getJobUnscoped, updateJob } from '../repo/jobs.js';
import { createSpec } from '../repo/specs.js';
import { getUserById, recordUsage } from '../repo/users.js';
import { rebuildIndex } from './index-writer.js';
import { withinLinkBudget } from '../implementation/guardrails.js';
import { sha256 } from '../util/ids.js';
import { createLogger, errorMessage } from '../util/logger.js';

const log = createLogger('pipeline');

export interface ProcessOptions {
  /** Skip the extraction cache and use the heavier path. POST /links/{id}/rerun. */
  force?: boolean;
  /**
   * Run the deep plan regardless of what triage scored it. Set when the user
   * taps "Plan this" on a capture that was parked in AWAITING_PLAN.
   */
  forcePlan?: boolean;
}

/**
 * Processing Orchestrator (spec §5.4).
 *
 * Drives one job RECEIVED → … → SPEC_READY. Each stage persists its result
 * before the next begins, so a crash resumes from the last completed stage
 * rather than restarting the paid work.
 */
export async function processJob(jobId: string, options: ProcessOptions = {}): Promise<void> {
  const job = getJobUnscoped(jobId);
  if (!job) {
    log.warn('job vanished before processing', { jobId });
    return;
  }
  const user = getUserById(job.userId);
  if (!user) {
    updateJob(jobId, { state: 'FAILED', statusMessage: 'The owning account no longer exists.' });
    return;
  }

  const cfg = config();
  log.info('processing capture', { jobId, inputKind: job.inputKind, platform: job.platform });

  // ── RESOLVED ──────────────────────────────────────────────────────────────
  // Only a link needs resolving. A note, a dictated thought or a photo arrives
  // carrying its own content and skips straight past the fetch waterfall.
  const isLink = job.inputKind === 'link';
  const platform = isLink ? resolvePlatform(job.url) : 'other';
  updateJob(jobId, {
    state: 'RESOLVED',
    platform,
    statusMessage: isLink
      ? `Recognised a ${PLATFORM_LABELS[platform]} link. Fetching the content…`
      : `Reading your ${INPUT_KIND_LABELS[job.inputKind].toLowerCase()}…`,
    failureCode: null,
    requiredAction: null,
  });

  // A provisional folder so every later stage has somewhere to write. It is
  // renamed once analysis produces a real title — see renameJobFolder below.
  const provisionalTitle =
    job.title ?? (isLink ? `${PLATFORM_LABELS[platform]} post` : INPUT_KIND_LABELS[job.inputKind]);
  const folderName = job.folderName ?? (await ensureJobFolder({ ...job, platform }, provisionalTitle));
  updateJob(jobId, { folderName });

  const workDir = path.join(jobFolder(job.userId, folderName), 'media');
  await fs.mkdir(workDir, { recursive: true });

  // ── FETCHED ───────────────────────────────────────────────────────────────
  // Extraction can contain private posts, personal feeds and user-supplied
  // context. It is therefore cached per user; a global URL cache would leak one
  // customer's authenticated transcript to another customer.
  const cacheKey = sha256(
    `extract:v3:${job.userId}:${job.normalizedUrl}:${sha256(job.sharedText ?? '')}:${sha256(job.note ?? '')}`,
  );
  type CachedExtraction = {
    segments: Awaited<ReturnType<typeof runTranscriptWaterfall>>['segments'];
    language: string;
    durationSec: number | null;
    vtt: string | null;
    methodsUsed: Awaited<ReturnType<typeof runTranscriptWaterfall>>['methodsUsed'];
    title?: string | null;
    author?: string | null;
    postDescription?: string | null;
    fetchMethods: string[];
    failureReason?: string | null;
    needsSignIn?: boolean;
    signInHost?: string | null;
  };

  let extraction: CachedExtraction | null =
    options.force || !isLink ? null : cacheGet<CachedExtraction>(job.userId, cacheKey);

  if (!isLink) {
    // Text the user supplied directly. It is verbatim by definition, so it
    // enters as one full-confidence segment rather than going through a
    // waterfall that has nothing to add.
    const body = (job.bodyText ?? job.sharedText ?? '').trim();
    const segments: InsightSegment[] = body
      ? [{ order: 0, text: body, provenance: 'user_note', confidence: 1 }]
      : [];
    extraction = {
      segments,
      language: 'en',
      durationSec: null,
      vtt: null,
      methodsUsed: segments.length > 0 ? ['user_note'] : [],
      title: job.title ?? null,
      author: null,
      postDescription: null,
      fetchMethods: [`direct_${job.inputKind}`],
      failureReason: segments.length === 0 ? 'This capture arrived empty.' : null,
    };
    updateJob(jobId, { state: 'TRANSCRIBED' });
  } else if (extraction) {
    log.info('reusing cached extraction', { jobId });
    updateJob(jobId, { state: 'TRANSCRIBED', statusMessage: 'Reused a previous extraction of this link.' });
  } else {
    const socialSession = await materializeSocialSession(job.userId, platform);
    const media = await fetchMedia({
      url: job.url,
      platform,
      workDir,
      // Rerun forces the heavier path even when captions look adequate.
      needAudio: true,
      needFrames: true,
      storageStatePath: socialSession?.storageStatePath ?? null,
      cookiesFilePath: socialSession?.cookiesFilePath ?? null,
    }).finally(() => socialSession?.cleanup());

    updateJob(jobId, {
      state: 'FETCHED',
      title: media.title ?? job.title,
      statusMessage: media.inaccessible
        ? media.needsSignIn
          ? `Sign in to ${PLATFORM_LABELS[platform]} once so this post can be read.`
          : 'The content could not be retrieved. Treating this as an extraction failure…'
        : 'Got the content. Reading the transcript and on-screen text…',
    });

    // ── TRANSCRIBED ─────────────────────────────────────────────────────────
    const transcript = media.needsSignIn
      ? {
          segments: [],
          language: 'en',
          durationSec: media.durationSec ?? null,
          vtt: null,
          methodsUsed: [],
          cost: { asrSeconds: 0, usd: 0 },
          failureReason: media.inaccessibleReason ?? `Sign in to ${PLATFORM_LABELS[platform]} to read this post.`,
        }
      : await runTranscriptWaterfall({
          media,
          platform,
          sharedText: job.sharedText,
          note: job.note,
        });

    addJobCost(jobId, { asrSeconds: transcript.cost.asrSeconds, usd: transcript.cost.usd });
    recordUsage(job.userId, { asrSeconds: transcript.cost.asrSeconds, usd: transcript.cost.usd });

    extraction = {
      segments: transcript.segments,
      language: transcript.language,
      durationSec: transcript.durationSec,
      vtt: transcript.vtt,
      methodsUsed: transcript.methodsUsed,
      title: media.title,
      author: media.author,
      postDescription: media.description,
      fetchMethods: media.methods,
      failureReason: transcript.failureReason,
      needsSignIn: media.needsSignIn,
      signInHost: media.signInHost,
    };

    if (transcript.segments.length > 0) cacheSet(job.userId, cacheKey, extraction);
    updateJob(jobId, { state: 'TRANSCRIBED' });
  }

  const currentJob = getJobUnscoped(jobId) ?? job;
  await writeSource(job.userId, folderName, currentJob, {
    title: extraction.title,
    author: extraction.author,
    methods: extraction.fetchMethods,
  });

  // Nothing usable is an acquisition failure, never evidence that the link had
  // no value. Ask for authentication when it can unblock the job; otherwise
  // surface a product failure with a typed recovery action for support/ops.
  if (extraction.segments.length === 0) {
    const reason = extraction.failureReason ?? 'No usable content could be extracted from this link.';
    const needsSignIn = extraction.needsSignIn === true;
    const statusMessage = needsSignIn
      ? reason
      : `We could not read this link yet. This is an extraction failure, not a claim that the link had no useful insight. ${reason}`;
    updateJob(jobId, {
      state: needsSignIn ? 'NEEDS_INPUT' : 'FAILED',
      statusMessage,
      failureCode: needsSignIn ? 'social_auth_required' : 'extraction_failed',
      requiredAction: needsSignIn
        ? {
            kind: 'connect_social',
            platform: platform === 'other' ? null : platform,
            message: `Sign in to ${PLATFORM_LABELS[platform]} once, then this link will be retried.`,
          }
        : {
            kind: reason.includes('not configured') ? 'configure_provider' : 'retry',
            message: 'Fix or configure the missing extraction capability, then retry this link.',
          },
    });
    await writeTranscript(job.userId, folderName, { vtt: null, text: `(nothing extracted)\n\n${reason}` });
    audit({
      userId: job.userId,
      jobId,
      event: needsSignIn ? 'job.auth_required' : 'job.extraction_failed',
      detail: reason,
    });
    await rebuildIndex(job.userId);
    await notifySpecReady({ user, job: getJobUnscoped(jobId)!, itemCount: 0, noContent: true, reason: statusMessage });
    return;
  }

  // ── NORMALIZED ────────────────────────────────────────────────────────────
  const normalized = normalize({
    segments: extraction.segments,
    postDescription: extraction.postDescription,
    platform,
  });

  const source = saveInsightSource({
    jobId,
    userId: job.userId,
    segments: normalized.segments,
    postDescription: extraction.postDescription ?? null,
    language: extraction.language,
    durationSec: extraction.durationSec,
    overallConfidence: normalized.overallConfidence,
    lowConfidence: normalized.lowConfidence,
    methodsUsed: normalized.methodsUsed,
  });

  await writeTranscript(job.userId, folderName, {
    vtt: extraction.vtt,
    text: normalized.transcriptText,
  });
  await writeInsights(job.userId, folderName, source);

  updateJob(jobId, {
    state: 'NORMALIZED',
    statusMessage: normalized.lowConfidence
      ? 'Content extracted, but confidence is low. Sizing it up anyway…'
      : 'Content extracted. Sizing up what it is worth…',
  });

  // ── TRIAGED (phase A) ─────────────────────────────────────────────────────
  // The cheap pass. It decides whether this capture earns the expensive one,
  // which is what makes capturing thirty things on a commute affordable.
  const context = buildLifeContext(job.userId);
  let triageResult: TriageResult | null = null;

  if (cfg.enableTriage && !options.forcePlan) {
    triageResult = await triage({
      text: normalized.mergedText,
      contextBrief: context.brief,
      sourceLabel: isLink ? PLATFORM_LABELS[platform] : INPUT_KIND_LABELS[job.inputKind],
    });

    addJobCost(jobId, { modelTokens: triageResult.usage.modelTokens, usd: triageResult.usage.usd });
    recordUsage(job.userId, { modelTokens: triageResult.usage.modelTokens, usd: triageResult.usage.usd });

    updateJob(jobId, {
      state: 'TRIAGED',
      triageVerdict: triageResult.verdict,
      valueScore: triageResult.valueScore,
      domains: triageResult.domains,
      statusMessage: triageResult.headline,
    });
    audit({
      userId: job.userId,
      jobId,
      event: 'job.triaged',
      detail: `${triageResult.verdict} · value ${triageResult.valueScore.toFixed(2)} · ${triageResult.engine}`,
    });

    // Worth something, but not enough to plan unprompted. Park it with its
    // headline so the user can spend the deep call themselves.
    //
    // The gate only applies when planning actually costs something. With no
    // model configured the deep pass is the rule-based analyzer, which is free —
    // parking a capture then would cost the user an extra tap and save nothing.
    // Only a successful model triage may park a paid planning pass. If triage
    // itself fell back to heuristics, continue to the planner rather than let
    // an approximate score block a capture or break a provider recovery path.
    const planningCostsMoney = llm().live && triageResult.engine === 'claude';
    if (
      planningCostsMoney &&
      triageResult.verdict !== 'no_action' &&
      !shouldAutoPlan(triageResult, user.preferences.autoPlanThreshold)
    ) {
      updateJob(jobId, {
        state: 'AWAITING_PLAN',
        statusMessage: `${triageResult.headline} Tap “Plan this” when you want the full plan.`,
      });
      audit({ userId: job.userId, jobId, event: 'job.parked', detail: 'below the auto-plan threshold' });
      await rebuildIndex(job.userId);
      await notifySpecReady({
        user,
        job: getJobUnscoped(jobId)!,
        itemCount: 0,
        noContent: false,
        reason: triageResult.headline,
      });
      return;
    }
  }

  await planJob(jobId, { triageResult });
}

/**
 * Phase B — the deep, personalized plan (spec §4.4b).
 *
 * Split out from `processJob` because it is the expensive half and is entered
 * two ways: automatically when triage rates a capture highly, or on demand when
 * the user taps "Plan this" on something that was parked. It reads the insight
 * source that extraction already persisted, so re-planning never re-fetches or
 * re-transcribes anything.
 */
export async function planJob(
  jobId: string,
  options: { triageResult?: TriageResult | null } = {},
): Promise<void> {
  const job = getJobUnscoped(jobId);
  if (!job) return;
  const user = getUserById(job.userId);
  if (!user) return;

  const cfg = config();
  const folderName = job.folderName;
  if (!folderName) {
    updateJob(jobId, { state: 'FAILED', statusMessage: 'This capture has no artifact folder.' });
    return;
  }

  const source = getInsightSourceByJob(jobId);
  if (!source || source.segments.length === 0) {
    const message = 'There is no extracted content to plan against. Retry extraction before planning.';
    updateJob(jobId, {
      state: 'FAILED',
      statusMessage: message,
      failureCode: 'extraction_failed',
      requiredAction: { kind: 'retry', message },
    });
    await rebuildIndex(job.userId);
    return;
  }

  const platform = job.platform;

  updateJob(jobId, {
    state: 'ANALYZED',
    statusMessage: 'Working out what you should do about this…',
  });

  const spent = job.cost.usd;
  if (!withinLinkBudget(spent)) {
    const message = `This capture hit the per-item budget of $${cfg.maxUsdPerLink.toFixed(2)} during extraction, so planning was skipped.`;
    updateJob(jobId, {
      state: 'NEEDS_INPUT',
      statusMessage: message,
      failureCode: 'link_budget_exceeded',
      requiredAction: { kind: 'increase_budget', message },
    });
    audit({ userId: job.userId, jobId, event: 'budget.link_exceeded', detail: message });
    await rebuildIndex(job.userId);
    return;
  }

  // Rebuild the merged text from the stored segments in the same tagged form
  // the analyzer expects.
  const mergedText = source.segments
    .map((segment) => `[${segment.order}] (${segment.provenance}) ${segment.text}`)
    .join('\n');

  const context = buildLifeContext(job.userId);
  const analysis = await analyze({
    userId: job.userId,
    mergedText,
    platform,
    inputKind: job.inputKind,
    url: job.url,
    postTitle: job.title,
    author: null,
    lowConfidence: source.lowConfidence,
    overallConfidence: source.overallConfidence,
    lifeContext: context,
    triage: options.triageResult ?? null,
    mutedDomains: user.preferences.mutedDomains,
    learnAboutMe: user.preferences.learnAboutMe,
  });

  addJobCost(jobId, { modelTokens: analysis.usage.modelTokens, usd: analysis.usage.usd });
  recordUsage(job.userId, { modelTokens: analysis.usage.modelTokens, usd: analysis.usage.usd, jobs: 1 });

  // Now that there is a real title, give the folder a browsable name (BR-F3).
  const finalFolder = await renameJobFolder(job.userId, folderName, job.createdAt, platform, analysis.title);
  updateJob(jobId, {
    state: 'ANALYZED',
    title: analysis.title,
    folderName: finalFolder,
    domains: analysis.domains,
  });

  const spec = createSpec({
    jobId,
    userId: job.userId,
    title: analysis.title,
    summaryPlainEnglish: analysis.summaryPlainEnglish,
    technicalSpec: analysis.technicalSpec,
    noActionableItems: analysis.noActionableItems,
    items: analysis.items,
    pathways: analysis.pathways,
    domains: analysis.domains,
    proposedFacts: analysis.proposedFacts,
  });

  // Anything the analyzer noticed about the person is queued for confirmation,
  // never applied. The profile only grows when the user says it may.
  if (analysis.proposedFacts.length > 0 && user.preferences.learnAboutMe) {
    const added = proposeFacts(job.userId, jobId, analysis.proposedFacts);
    if (added > 0) {
      audit({ userId: job.userId, jobId, event: 'profile.facts_proposed', detail: `${added} pending` });
    }
  }

  const jobWithTitle = getJobUnscoped(jobId)!;
  await writeSummary(job.userId, finalFolder, jobWithTitle, spec);
  await writeSpec(job.userId, finalFolder, spec);

  const routeNote =
    spec.pathways.length > 1 ? ` across ${spec.pathways.length} routes` : '';
  const hasItems = spec.items.length > 0;
  const failureMessage =
    'The capture was retrieved, but analysis did not produce an implementation path. This is a product failure; retry the analysis.';
  updateJob(jobId, {
    state: hasItems ? 'SPEC_READY' : 'FAILED',
    statusMessage: hasItems
      ? `${spec.items.length} thing${spec.items.length === 1 ? '' : 's'} you could do${routeNote}.`
      : failureMessage,
    failureCode: hasItems ? null : 'analysis_failed',
    requiredAction: hasItems ? null : { kind: 'retry', message: failureMessage },
  });

  audit({
    userId: job.userId,
    jobId,
    event: 'job.spec_ready',
    detail: `${spec.items.length} items · ${spec.pathways.length} pathways · ${analysis.analyzer} analyzer`,
  });

  await rebuildIndex(job.userId);
  await notifySpecReady({
    user,
    job: getJobUnscoped(jobId)!,
    itemCount: spec.items.length,
    noContent: false,
    specId: spec.specId,
  });

  log.info('spec ready', {
    jobId,
    items: spec.items.length,
    pathways: spec.pathways.length,
    analyzer: analysis.analyzer,
  });
}

/** Marks a job failed after the queue exhausted its retries. */
export function failJob(jobId: string, error: string): void {
  const job = getJobUnscoped(jobId);
  if (!job) return;
  updateJob(jobId, {
    state: 'FAILED',
    statusMessage: `Processing failed after several attempts: ${error}`,
  });
  audit({ userId: job.userId, jobId, event: 'job.failed', detail: error.slice(0, 500) });
  rebuildIndex(job.userId).catch((err) => log.warn('index rebuild failed', { error: errorMessage(err) }));
}

export type { Job };
