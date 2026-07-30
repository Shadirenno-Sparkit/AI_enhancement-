import { Router } from 'express';
import { z } from 'zod';
import type { CaptureResponse, CaptureSource } from '@aiapp/shared';
import { CAPTURE_SOURCES, extractUrl, normalizeUrl, resolvePlatform, stripUrl } from '@aiapp/shared';
import { removeJobFolder } from '../../artifacts/fileManager.js';
import { assertWithinDailyBudget } from '../../implementation/guardrails.js';
import { libraryEntryFor, libraryFor, rebuildIndex } from '../../orchestrator/index-writer.js';
import { enqueue } from '../../queue/queue.js';
import { audit } from '../../repo/audit.js';
import { createOrGetJob, deleteJob, getJob } from '../../repo/jobs.js';
import { badRequest, notFound } from '../../util/errors.js';
import { asyncHandler, currentUser, rateLimit, requireAuth } from '../middleware.js';

export const linksRouter = Router();
linksRouter.use(requireAuth);

const captureSchema = z.object({
  // Not `.url()`: the share sheet often hands over "caption text… https://link",
  // so we accept free text and pull the URL out of it (spec §4.1).
  url: z.string().min(1).max(4000),
  sharedText: z.string().max(20_000).optional(),
  note: z.string().max(1000).optional(),
  captureSource: z.enum(CAPTURE_SOURCES).optional(),
  clientRef: z.string().max(120).optional(),
});

/**
 * POST /v1/links — the one endpoint that must never feel slow or fail.
 *
 * It persists the submission and returns immediately; all processing happens on
 * the queue (spec §3 "Capture is sacred and trivial"). The rate limit is set
 * high enough that an offline queue flushing a backlog sails through.
 */
linksRouter.post(
  '/',
  rateLimit({ capacity: 60, refillPerSecond: 1, key: 'capture' }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const parsed = captureSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('A link is required.', parsed.error.flatten().fieldErrors);

    const raw = parsed.data.url.trim();
    const url = extractUrl(raw) ?? (/^https?:\/\//i.test(raw) ? raw : null);
    if (!url) {
      throw badRequest(
        'No web link was found in what you shared. Share a post link, or paste the URL directly.',
      );
    }

    assertWithinDailyBudget(user.userId);

    // Anything shared alongside the link is context — the caption the app copied.
    const trailing = stripUrl(raw, url);
    const sharedText = [parsed.data.sharedText, trailing].filter(Boolean).join('\n').trim() || null;

    const normalizedUrl = normalizeUrl(url);
    const platform = resolvePlatform(url);
    const captureSource: CaptureSource = parsed.data.captureSource ?? 'api';

    const { job, deduped } = createOrGetJob({
      userId: user.userId,
      url,
      normalizedUrl,
      platform,
      sharedText,
      note: parsed.data.note ?? null,
      captureSource,
    });

    if (!deduped) {
      enqueue({ jobId: job.jobId, kind: 'process' });
      audit({ userId: user.userId, jobId: job.jobId, event: 'link.captured', detail: `${platform} · ${captureSource}` });
    }

    const body: CaptureResponse = { jobId: job.jobId, state: job.state, deduped };
    res.status(deduped ? 200 : 202).json(body);
  }),
);

/** GET /v1/library — the backlog/index view (spec §8). */
linksRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const limit = Math.min(Number(req.query['limit'] ?? 100) || 100, 500);
    res.json({ entries: libraryFor(user.userId, limit) });
  }),
);

linksRouter.get(
  '/:jobId',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const job = getJob(String(req.params['jobId']), user.userId);
    if (!job) throw notFound('No such link.');
    res.json({ entry: libraryEntryFor(job) });
  }),
);

/**
 * POST /v1/links/{id}/rerun — re-extract with the heavier path.
 * The confidence-gating escape hatch from spec §6.5.
 */
linksRouter.post(
  '/:jobId/rerun',
  rateLimit({ capacity: 10, refillPerSecond: 1 / 60, key: 'rerun' }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const job = getJob(String(req.params['jobId']), user.userId);
    if (!job) throw notFound('No such link.');

    assertWithinDailyBudget(user.userId);
    enqueue({ jobId: job.jobId, kind: 'process', payload: { force: true } });
    audit({ userId: user.userId, jobId: job.jobId, event: 'link.rerun' });

    res.status(202).json({ jobId: job.jobId, state: 'RECEIVED' });
  }),
);

linksRouter.delete(
  '/:jobId',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const job = getJob(String(req.params['jobId']), user.userId);
    if (!job) throw notFound('No such link.');

    if (job.folderName) await removeJobFolder(user.userId, job.folderName);
    deleteJob(job.jobId, user.userId);
    audit({ userId: user.userId, jobId: job.jobId, event: 'link.deleted' });
    await rebuildIndex(user.userId);

    res.status(204).end();
  }),
);
