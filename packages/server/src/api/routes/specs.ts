import { Router } from 'express';
import { z } from 'zod';
import type { DecisionResponse } from '@aiapp/shared';
import { DECISION_CHOICES } from '@aiapp/shared';
import { writeDecisions, writePlan } from '../../artifacts/fileManager.js';
import { evaluateAutonomy } from '../../implementation/guardrails.js';
import { revertItem } from '../../implementation/engine.js';
import { rebuildIndex } from '../../orchestrator/index-writer.js';
import { enqueue } from '../../queue/queue.js';
import { audit } from '../../repo/audit.js';
import { getInsightSourceByJob } from '../../repo/insights.js';
import { getJob, updateJob } from '../../repo/jobs.js';
import { createRun, getRun, latestRunForSpec } from '../../repo/runs.js';
import {
  decisionStatsByType,
  getSpec,
  listDecisions,
  recordDecision,
} from '../../repo/specs.js';
import { badRequest, notFound } from '../../util/errors.js';
import { asyncHandler, currentUser, rateLimit, requireAuth } from '../middleware.js';

export const specsRouter = Router();
specsRouter.use(requireAuth);

/**
 * GET /v1/specs/{specId} — everything the review UI needs in one call:
 * the summary, each item with its current decision, the extraction provenance
 * behind it, and the latest run.
 */
specsRouter.get(
  '/:specId',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const spec = getSpec(String(req.params['specId']), user.userId);
    if (!spec) throw notFound('No such spec.');

    const job = getJob(spec.jobId, user.userId);
    const decisions = listDecisions(spec.specId);
    const decided = new Map(decisions.map((d) => [d.itemId, d]));
    const source = getInsightSourceByJob(spec.jobId);
    const run = latestRunForSpec(spec.specId);

    // Preference signal: categories this user consistently approves are worth
    // surfacing, which is what the decision log is for (BR-R4, O6).
    const stats = decisionStatsByType(user.userId);

    res.json({
      spec: {
        ...spec,
        items: spec.items.map((item) => ({
          ...item,
          decision: decided.get(item.itemId)?.decision ?? null,
          edits: decided.get(item.itemId)?.edits ?? null,
          // Everything the item was drawn from, so the user can check the claim.
          sourceExcerpts: (item.sourceSegments ?? [])
            .map((order) => source?.segments.find((segment) => segment.order === order))
            .filter((segment): segment is NonNullable<typeof segment> => Boolean(segment))
            .map((segment) => ({
              order: segment.order,
              text: segment.text,
              provenance: segment.provenance,
              confidence: segment.confidence,
            })),
          autonomy: evaluateAutonomy(user, item, false),
          affinity: stats[item.type] ?? null,
        })),
      },
      job,
      extraction: source
        ? {
            overallConfidence: source.overallConfidence,
            lowConfidence: source.lowConfidence,
            methodsUsed: source.methodsUsed,
            language: source.language,
            durationSec: source.durationSec,
            segmentCount: source.segments.length,
          }
        : null,
      run,
    });
  }),
);

const decisionSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: z.string().min(1),
        decision: z.enum(DECISION_CHOICES),
        edits: z.record(z.unknown()).optional(),
      }),
    )
    .min(1, 'Decide on at least one item.')
    .max(100),
  dryRun: z.boolean().optional(),
});

/**
 * POST /v1/specs/{specId}/decisions — the human gate (spec §9).
 *
 * Records every choice, then queues a run for the approved items. Items the
 * trust dial holds back are reported so the UI can ask for the extra
 * confirmation rather than silently doing nothing.
 */
specsRouter.post(
  '/:specId/decisions',
  rateLimit({ capacity: 30, refillPerSecond: 1, key: 'decisions' }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const spec = getSpec(String(req.params['specId']), user.userId);
    if (!spec) throw notFound('No such spec.');

    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Check your selections.', parsed.error.flatten().fieldErrors);

    const known = new Map(spec.items.map((item) => [item.itemId, item]));
    const unknown = parsed.data.items.filter((entry) => !known.has(entry.itemId));
    if (unknown.length > 0) {
      throw badRequest(`Unknown item${unknown.length === 1 ? '' : 's'}: ${unknown.map((u) => u.itemId).join(', ')}`);
    }

    for (const entry of parsed.data.items) {
      recordDecision({
        specId: spec.specId,
        itemId: entry.itemId,
        userId: user.userId,
        decision: entry.decision,
        edits: entry.edits ?? null,
      });
      audit({
        userId: user.userId,
        jobId: spec.jobId,
        itemId: entry.itemId,
        event: `decision.${entry.decision}`,
        detail: known.get(entry.itemId)?.title ?? '',
      });
    }

    const decisions = listDecisions(spec.specId);
    await writeDecisions(user.userId, jobFolderName(spec.jobId, user.userId), spec, decisions).catch(() => undefined);
    await writePlan(user.userId, jobFolderName(spec.jobId, user.userId), spec, decisions).catch(() => undefined);

    const approvedItems = parsed.data.items
      .filter((entry) => entry.decision === 'approve')
      .map((entry) => known.get(entry.itemId)!);

    const awaitingConfirmation = approvedItems
      .filter((item) => !evaluateAutonomy(user, item, parsed.data.dryRun ?? false).autoImplement)
      .map((item) => item.itemId);

    let runId: string | null = null;
    if (approvedItems.length > 0) {
      const run = createRun({
        specId: spec.specId,
        jobId: spec.jobId,
        userId: user.userId,
        dryRun: parsed.data.dryRun ?? user.preferences.dryRunFirst,
      });
      runId = run.runId;
      updateJob(spec.jobId, { state: 'IMPLEMENTING', statusMessage: 'Queued for implementation…' });
      enqueue({ jobId: spec.jobId, kind: 'implement', payload: { runId } });
    } else {
      updateJob(spec.jobId, {
        state: 'NO_ACTION',
        statusMessage: 'You skipped everything from this link.',
      });
    }

    await rebuildIndex(user.userId);

    const body: DecisionResponse = {
      runId,
      awaitingConfirmation,
      dryRun: parsed.data.dryRun ?? user.preferences.dryRunFirst,
    };
    res.status(202).json(body);
  }),
);

function jobFolderName(jobId: string, userId: string): string {
  return getJob(jobId, userId)?.folderName ?? '';
}

specsRouter.post(
  '/:specId/revert/:itemId',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const spec = getSpec(String(req.params['specId']), user.userId);
    if (!spec) throw notFound('No such spec.');

    const run = latestRunForSpec(spec.specId);
    if (!run) throw notFound('This spec has not been run yet.');

    const result = await revertItem(run.runId, String(req.params['itemId']));
    if (!result.ok) throw badRequest('That item cannot be reverted automatically.');

    res.json({ reverted: true, steps: result.steps });
  }),
);

export const runsRouter = Router();
runsRouter.use(requireAuth);

/** GET /v1/runs/{runId} — per-item status plus the full action trail. */
runsRouter.get(
  '/:runId',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const run = getRun(String(req.params['runId']), user.userId);
    if (!run) throw notFound('No such run.');
    res.json({ run });
  }),
);
