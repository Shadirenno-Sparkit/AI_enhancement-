import { Router } from 'express';
import { getInsightSourceByJob } from '../../repo/insights.js';
import { getJob } from '../../repo/jobs.js';
import { latestRunForSpec } from '../../repo/runs.js';
import { getSpecByJob, listDecisions } from '../../repo/specs.js';
import { notFound } from '../../util/errors.js';
import { asyncHandler, currentUser, requireAuth } from '../middleware.js';

export const jobsRouter = Router();
jobsRouter.use(requireAuth);

/**
 * GET /v1/jobs/{jobId} — the polling endpoint the capture client uses to watch
 * a link move through the pipeline (spec §8).
 */
jobsRouter.get(
  '/:jobId',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const job = getJob(String(req.params['jobId']), user.userId);
    if (!job) throw notFound('No such link.');

    const spec = getSpecByJob(job.jobId);
    const run = spec ? latestRunForSpec(spec.specId) : null;
    const source = getInsightSourceByJob(job.jobId);
    const decisions = spec ? listDecisions(spec.specId) : [];

    res.json({
      job,
      specId: spec?.specId ?? null,
      itemCount: spec?.items.length ?? 0,
      decidedCount: decisions.length,
      runId: run?.runId ?? null,
      runStatus: run?.status ?? null,
      lowConfidence: source?.lowConfidence ?? false,
      // Coarse progress so the UI can show a bar without knowing the state machine.
      progress: progressFor(job.state),
    });
  }),
);

function progressFor(state: string): number {
  const STEPS: Record<string, number> = {
    RECEIVED: 5,
    RESOLVED: 15,
    FETCHED: 35,
    TRANSCRIBED: 55,
    NORMALIZED: 70,
    ANALYZED: 85,
    SPEC_READY: 100,
    AWAITING_DECISION: 100,
    IMPLEMENTING: 100,
    DONE: 100,
    PARTIAL: 100,
    NEEDS_INPUT: 100,
    NO_ACTION: 100,
    FAILED: 100,
  };
  return STEPS[state] ?? 0;
}
