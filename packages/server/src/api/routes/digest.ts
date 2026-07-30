import { Router } from 'express';
import { PLATFORM_LABELS } from '@aiapp/shared';
import { libraryEntryFor } from '../../orchestrator/index-writer.js';
import { jobsSince } from '../../repo/jobs.js';
import { listRunsForUser } from '../../repo/runs.js';
import { decisionStatsByType } from '../../repo/specs.js';
import { asyncHandler, currentUser, requireAuth } from '../middleware.js';

export const digestRouter = Router();
digestRouter.use(requireAuth);

/**
 * GET /v1/digest — the weekly digest (BRD §10 value-add).
 *
 * Turns the captured library into a lightweight learning journal: what you
 * captured, what got implemented, what you skipped, and what is still waiting.
 */
digestRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const days = Math.min(Math.max(Number(req.query['days'] ?? 7) || 7, 1), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const entries = jobsSince(user.userId, since).map(libraryEntryFor);
    const runs = listRunsForUser(user.userId, 200).filter((run) => run.startedAt >= since);

    const implemented = runs.flatMap((run) =>
      run.items.filter((item) => item.status === 'done').map((item) => ({
        title: item.title,
        type: item.type,
        summary: item.summary,
        runId: run.runId,
        at: run.finishedAt ?? run.startedAt,
      })),
    );

    const needsYou = runs.flatMap((run) =>
      run.items
        .filter((item) => item.status === 'needs_input')
        .map((item) => ({ title: item.title, needsInput: item.needsInput, runId: run.runId })),
    );

    const byPlatform: Record<string, number> = {};
    for (const entry of entries) {
      const label = PLATFORM_LABELS[entry.platform];
      byPlatform[label] = (byPlatform[label] ?? 0) + 1;
    }

    const totals = entries.reduce(
      (accumulator, entry) => ({
        captured: accumulator.captured + 1,
        approved: accumulator.approved + entry.itemCounts.approved,
        forgone: accumulator.forgone + entry.itemCounts.forgone,
        deferred: accumulator.deferred + entry.itemCounts.deferred,
        pending: accumulator.pending + entry.itemCounts.pending,
        usd: accumulator.usd + entry.cost.usd,
      }),
      { captured: 0, approved: 0, forgone: 0, deferred: 0, pending: 0, usd: 0 },
    );

    // The headline KPI from the BRD: how much of what you saved actually landed.
    const captureToAction =
      totals.captured === 0
        ? 0
        : entries.filter((entry) => entry.itemCounts.approved > 0).length / totals.captured;

    res.json({
      periodDays: days,
      since,
      totals: { ...totals, usd: Number(totals.usd.toFixed(4)) },
      captureToActionRate: Number(captureToAction.toFixed(3)),
      byPlatform,
      implemented,
      needsYou,
      awaitingReview: entries
        .filter((entry) => entry.state === 'SPEC_READY' && entry.itemCounts.pending > 0)
        .map((entry) => ({ jobId: entry.jobId, title: entry.title, items: entry.itemCounts.pending })),
      lowConfidence: entries
        .filter((entry) => entry.lowConfidence)
        .map((entry) => ({ jobId: entry.jobId, title: entry.title })),
      preferenceProfile: decisionStatsByType(user.userId),
    });
  }),
);
