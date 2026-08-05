import { Router } from 'express';
import { z } from 'zod';
import { RISK_TIERS, TRUST_POSTURES } from '@aiapp/shared';
import { purgeExpiredMedia, removeJobFolder, writeIndex } from '../../artifacts/fileManager.js';
import { config } from '../../config.js';
import { audit, listAudit } from '../../repo/audit.js';
import {
  deleteConnector,
  listConnectors,
  upsertConnector,
} from '../../repo/connectors.js';
import { listJobs } from '../../repo/jobs.js';
import {
  deletePushSubscription,
  listNotifications,
  markNotificationsRead,
  savePushSubscription,
} from '../../repo/notifications.js';
import { listScheduledTasks, setScheduledTaskEnabled, deleteScheduledTask } from '../../repo/schedules.js';
import { deleteUserData, revokeAllRefreshTokens, updatePreferences, usageToday, usageTotal } from '../../repo/users.js';
import { describeCron, isValidCron } from '../../implementation/cron.js';
import { badRequest, notFound } from '../../util/errors.js';
import { asyncHandler, currentUser, requireAuth } from '../middleware.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

const preferencesSchema = z.object({
  trustPosture: z.enum(TRUST_POSTURES).optional(),
  autoImplementTiers: z.array(z.enum(RISK_TIERS)).nullable().optional(),
  notifyChannels: z.array(z.string().max(30)).max(5).optional(),
  quietHours: z
    .object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) })
    .nullable()
    .optional(),
  desktopFolder: z.string().max(500).nullable().optional(),
  weeklyDigest: z.boolean().optional(),
  dryRunFirst: z.boolean().optional(),
  // Generous cap: this is a paragraph about someone's life, not a tweet.
  personalContext: z.string().max(4000).nullable().optional(),
});

usersRouter.patch(
  '/me/preferences',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const parsed = preferencesSchema.safeParse(req.body);
    if (!parsed.success) throw badRequest('Check those settings.', parsed.error.flatten().fieldErrors);

    const updated = updatePreferences(user.userId, parsed.data);
    audit({ userId: user.userId, event: 'preferences.updated', detail: Object.keys(parsed.data).join(', ') });
    res.json({ user: updated });
  }),
);

usersRouter.get(
  '/me/usage',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const cfg = config();
    const today = usageToday(user.userId);
    const total = usageTotal(user.userId);
    res.json({
      today: { ...today, usd: Number(today.usd.toFixed(4)) },
      total: { ...total, usd: Number(total.usd.toFixed(4)) },
      limits: {
        maxUsdPerLink: cfg.maxUsdPerLink,
        maxUsdPerUserPerDay: cfg.maxUsdPerUserPerDay,
        maxAsrSecondsPerLink: cfg.maxAsrSecondsPerLink,
      },
    });
  }),
);

usersRouter.get(
  '/me/audit',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const limit = Math.min(Number(req.query['limit'] ?? 200) || 200, 1000);
    res.json({ events: listAudit(user.userId, limit) });
  }),
);

/**
 * DELETE /v1/users/me/data — user-initiated erasure (spec §8, §12).
 * Removes database rows and on-disk artifacts; `keepAccount` lets someone clear
 * their history without losing their login.
 */
usersRouter.delete(
  '/me/data',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const keepAccount = req.query['keepAccount'] !== 'false';

    for (const job of listJobs(user.userId, 10_000)) {
      if (job.folderName) await removeJobFolder(user.userId, job.folderName).catch(() => undefined);
    }
    deleteUserData(user.userId, { keepAccount });
    revokeAllRefreshTokens(user.userId);
    if (keepAccount) await writeIndex(user.userId, []);

    audit({ event: 'user.data_deleted', detail: keepAccount ? 'history only' : 'account and history' });
    res.json({ deleted: true, accountKept: keepAccount });
  }),
);

// ─── Connectors ──────────────────────────────────────────────────────────────

usersRouter.get(
  '/me/connectors',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({ connectors: listConnectors(user.userId) });
  }),
);

usersRouter.put(
  '/me/connectors/:kind',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const parsed = z
      .object({
        label: z.string().max(80).optional(),
        // Stored encrypted and never returned; see repo/connectors.ts.
        secret: z.string().max(4000).nullable().optional(),
        scopes: z.array(z.string().max(60)).max(20).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('Check the connector details.');

    const kind = String(req.params['kind']).toLowerCase().slice(0, 40);
    if (!/^[a-z0-9-]+$/.test(kind)) throw badRequest('Connector names may use letters, numbers and hyphens.');

    const connector = upsertConnector({ userId: user.userId, kind, ...parsed.data });
    audit({ userId: user.userId, event: 'connector.saved', detail: kind });
    res.json({ connector });
  }),
);

usersRouter.delete(
  '/me/connectors/:kind',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const kind = String(req.params['kind']).toLowerCase();
    if (!deleteConnector(user.userId, kind)) throw notFound('No such connector.');
    audit({ userId: user.userId, event: 'connector.deleted', detail: kind });
    res.status(204).end();
  }),
);

// ─── Scheduled tasks ─────────────────────────────────────────────────────────

usersRouter.get(
  '/me/schedules',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({
      tasks: listScheduledTasks(user.userId).map((task) => ({
        ...task,
        humanReadable: describeCron(task.cron),
        valid: isValidCron(task.cron),
      })),
    });
  }),
);

usersRouter.patch(
  '/me/schedules/:taskId',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) throw badRequest('Specify whether the task is enabled.');
    if (!setScheduledTaskEnabled(String(req.params['taskId']), user.userId, parsed.data.enabled)) {
      throw notFound('No such scheduled task.');
    }
    res.json({ updated: true });
  }),
);

usersRouter.delete(
  '/me/schedules/:taskId',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    // Scoped delete: confirm ownership before removing.
    const owned = listScheduledTasks(user.userId).some((task) => task.taskId === String(req.params['taskId']));
    if (!owned) throw notFound('No such scheduled task.');
    deleteScheduledTask(String(req.params['taskId']));
    res.status(204).end();
  }),
);

// ─── Notifications ───────────────────────────────────────────────────────────

usersRouter.get(
  '/me/notifications',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({ notifications: listNotifications(user.userId, 100) });
  }),
);

usersRouter.post(
  '/me/notifications/read',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const parsed = z.object({ ids: z.array(z.string()).max(200).optional() }).safeParse(req.body ?? {});
    const updated = markNotificationsRead(user.userId, parsed.success ? parsed.data.ids : undefined);
    res.json({ updated });
  }),
);

usersRouter.post(
  '/me/push-subscription',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const parsed = z
      .object({
        endpoint: z.string().url().max(2000),
        keys: z.object({ p256dh: z.string().max(500), auth: z.string().max(500) }),
      })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest('That push subscription is not valid.');

    savePushSubscription(user.userId, parsed.data.endpoint, parsed.data.keys);
    res.status(201).json({ saved: true });
  }),
);

usersRouter.delete(
  '/me/push-subscription',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const endpoint = typeof req.query['endpoint'] === 'string' ? req.query['endpoint'] : null;
    if (!endpoint) throw badRequest('An endpoint is required.');
    deletePushSubscription(user.userId, endpoint);
    res.status(204).end();
  }),
);

usersRouter.post(
  '/me/purge-media',
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const removed = await purgeExpiredMedia(user.userId, config().mediaRetentionDays);
    res.json({ removed });
  }),
);
