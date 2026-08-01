import fs from 'node:fs/promises';
import path from 'node:path';
import type { Job } from '@aiapp/shared';
import { PLATFORM_LABELS, resolvePlatform } from '@aiapp/shared';
import { config } from '../config.js';
import { analyze } from '../analysis/analyzer.js';
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
import { normalize } from '../ingestion/normalizer.js';
import { runTranscriptWaterfall } from '../ingestion/transcript.js';
import { notifySpecReady } from '../notifications/notify.js';
import { audit } from '../repo/audit.js';
import { cacheGet, cacheSet, saveInsightSource } from '../repo/insights.js';
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
  log.info('processing link', { jobId, platform: job.platform, url: job.normalizedUrl });

  // ── RESOLVED ──────────────────────────────────────────────────────────────
  const platform = resolvePlatform(job.url);
  updateJob(jobId, {
    state: 'RESOLVED',
    platform,
    statusMessage: `Recognised a ${PLATFORM_LABELS[platform]} link. Fetching the content…`,
  });

  // A provisional folder so every later stage has somewhere to write. It is
  // renamed once analysis produces a real title — see renameJobFolder below.
  const provisionalTitle = job.title ?? `${PLATFORM_LABELS[platform]} post`;
  const folderName = job.folderName ?? (await ensureJobFolder({ ...job, platform }, provisionalTitle));
  updateJob(jobId, { folderName });

  const workDir = path.join(jobFolder(job.userId, folderName), 'media');
  await fs.mkdir(workDir, { recursive: true });

  // ── FETCHED ───────────────────────────────────────────────────────────────
  // Content-hash cache: a link anyone has already extracted is instant and free
  // (spec §6.5). Extraction output is not user-specific, so this is safe to share.
  const cacheKey = sha256(`extract:v1:${job.normalizedUrl}`);
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
  };

  let extraction: CachedExtraction | null = options.force ? null : cacheGet<CachedExtraction>(cacheKey);
  if (extraction) {
    log.info('reusing cached extraction', { jobId });
    updateJob(jobId, { state: 'TRANSCRIBED', statusMessage: 'Reused a previous extraction of this link.' });
  } else {
    const media = await fetchMedia({
      url: job.url,
      platform,
      workDir,
      // Rerun forces the heavier path even when captions look adequate.
      needAudio: true,
      needFrames: true,
    });

    updateJob(jobId, {
      state: 'FETCHED',
      title: media.title ?? job.title,
      statusMessage: media.inaccessible
        ? 'The platform would not serve this content.'
        : 'Got the content. Reading the transcript and on-screen text…',
    });

    // ── TRANSCRIBED ─────────────────────────────────────────────────────────
    const transcript = await runTranscriptWaterfall({
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
    };

    if (transcript.segments.length > 0) cacheSet(cacheKey, extraction);
    updateJob(jobId, { state: 'TRANSCRIBED' });
  }

  const currentJob = getJobUnscoped(jobId) ?? job;
  await writeSource(job.userId, folderName, currentJob, {
    title: extraction.title,
    author: extraction.author,
    methods: extraction.fetchMethods,
  });

  // Nothing usable — say so plainly and file a minimal record (BR-U7, use case 9.4).
  if (extraction.segments.length === 0) {
    const reason = extraction.failureReason ?? 'No usable content could be extracted from this link.';
    updateJob(jobId, { state: 'NO_ACTION', statusMessage: reason });
    await writeTranscript(job.userId, folderName, { vtt: null, text: `(nothing extracted)\n\n${reason}` });
    audit({ userId: job.userId, jobId, event: 'job.no_content', detail: reason });
    await rebuildIndex(job.userId);
    await notifySpecReady({ user, job: getJobUnscoped(jobId)!, itemCount: 0, noContent: true, reason });
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
      ? 'Content extracted, but confidence is low. Analysing it anyway…'
      : 'Content extracted. Working out what it is recommending…',
  });

  // ── ANALYZED / SPEC_READY ─────────────────────────────────────────────────
  const spent = getJobUnscoped(jobId)?.cost.usd ?? 0;
  if (!withinLinkBudget(spent)) {
    const message = `This link hit the per-link budget of $${cfg.maxUsdPerLink.toFixed(2)} during extraction, so analysis was skipped.`;
    updateJob(jobId, { state: 'NEEDS_INPUT', statusMessage: message });
    audit({ userId: job.userId, jobId, event: 'budget.link_exceeded', detail: message });
    await rebuildIndex(job.userId);
    return;
  }

  const analysis = await analyze({
    userId: job.userId,
    mergedText: normalized.mergedText,
    platform,
    url: job.url,
    postTitle: extraction.title,
    author: extraction.author,
    lowConfidence: normalized.lowConfidence,
    overallConfidence: normalized.overallConfidence,
  });

  addJobCost(jobId, { modelTokens: analysis.usage.modelTokens, usd: analysis.usage.usd });
  recordUsage(job.userId, { modelTokens: analysis.usage.modelTokens, usd: analysis.usage.usd, jobs: 1 });

  // Now that there is a real title, give the folder a browsable name (BR-F3).
  const finalFolder = await renameJobFolder(job.userId, folderName, job.createdAt, platform, analysis.title);
  updateJob(jobId, { state: 'ANALYZED', title: analysis.title, folderName: finalFolder });

  const spec = createSpec({
    jobId,
    userId: job.userId,
    title: analysis.title,
    summaryPlainEnglish: analysis.summaryPlainEnglish,
    technicalSpec: analysis.technicalSpec,
    noActionableItems: analysis.noActionableItems,
    items: analysis.items,
  });

  const jobWithTitle = getJobUnscoped(jobId)!;
  await writeSummary(job.userId, finalFolder, jobWithTitle, spec);
  await writeSpec(job.userId, finalFolder, spec);

  const finalState = spec.items.length === 0 ? 'NO_ACTION' : 'SPEC_READY';
  updateJob(jobId, {
    state: finalState,
    statusMessage:
      spec.items.length === 0
        ? 'No actionable items were found in this post.'
        : `${spec.items.length} improvement${spec.items.length === 1 ? '' : 's'} ready for you to review.`,
  });

  audit({
    userId: job.userId,
    jobId,
    event: 'job.spec_ready',
    detail: `${spec.items.length} items via ${analysis.analyzer} analyzer`,
  });

  await rebuildIndex(job.userId);
  await notifySpecReady({
    user,
    job: getJobUnscoped(jobId)!,
    itemCount: spec.items.length,
    noContent: false,
    specId: spec.specId,
  });

  log.info('spec ready', { jobId, items: spec.items.length, analyzer: analysis.analyzer });
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
