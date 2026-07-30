import type { Job, User } from '@aiapp/shared';
import { config } from '../config.js';
import { insertNotification, listPushSubscriptions } from '../repo/notifications.js';
import { createLogger, errorMessage } from '../util/logger.js';

const log = createLogger('notify');

export interface NotificationPayload {
  userId: string;
  jobId?: string | null;
  kind: string;
  title: string;
  body: string;
  url?: string;
}

/**
 * Notification Service (spec §4.2).
 *
 * Every notification is recorded in the database first — the in-app bell is the
 * channel that always works — then fanned out to push and email if configured.
 * A channel failure is logged, never fatal: a delivery problem must not fail a job.
 */
export async function notify(payload: NotificationPayload, user?: User): Promise<void> {
  const cfg = config();
  const channels = user?.preferences.notifyChannels ?? cfg.notifyChannels;
  const deferredUntil = quietHoursDeferral(user);

  const record = insertNotification({
    userId: payload.userId,
    jobId: payload.jobId ?? null,
    kind: payload.kind,
    title: payload.title,
    body: payload.body,
    deferredUntil,
  });

  if (deferredUntil) {
    log.debug('notification deferred by quiet hours', { until: deferredUntil });
    return;
  }

  await deliver(record.notificationId, payload, channels);
}

export async function deliver(
  notificationId: string,
  payload: NotificationPayload,
  channels: string[],
): Promise<void> {
  for (const channel of channels) {
    try {
      if (channel === 'log') {
        log.info(`🔔 ${payload.title}`, { body: payload.body, userId: payload.userId });
      } else if (channel === 'webpush') {
        await sendWebPush(payload);
      } else if (channel === 'email') {
        await sendEmail(payload);
      }
    } catch (err) {
      log.warn('notification channel failed', { channel, notificationId, error: errorMessage(err) });
    }
  }
}

/**
 * Returns an ISO timestamp to hold a notification until, or null to send now.
 * Quiet hours are the "quiet defaults" mitigation for notification fatigue (BRD R7).
 */
function quietHoursDeferral(user?: User): string | null {
  const quiet = user?.preferences.quietHours ?? config().quietHours;
  if (!quiet) return null;
  const { start, end } = quiet;
  if (start === end) return null;

  const now = new Date();
  const hour = now.getUTCHours();
  // A window like 22→7 wraps midnight; 9→17 does not.
  const inQuiet = start > end ? hour >= start || hour < end : hour >= start && hour < end;
  if (!inQuiet) return null;

  const release = new Date(now);
  release.setUTCMinutes(0, 0, 0);
  release.setUTCHours(end);
  if (release.getTime() <= now.getTime()) release.setUTCDate(release.getUTCDate() + 1);
  return release.toISOString();
}

async function sendWebPush(payload: NotificationPayload): Promise<void> {
  const cfg = config();
  if (!cfg.vapidPublicKey || !cfg.vapidPrivateKey) return;

  const webpush = await import('web-push');
  webpush.default.setVapidDetails(`mailto:${cfg.notifyFrom}`, cfg.vapidPublicKey, cfg.vapidPrivateKey);

  const subscriptions = listPushSubscriptions(payload.userId);
  const body = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? cfg.publicUrl,
  });

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.default.sendNotification(
          { endpoint: subscription.endpoint, keys: subscription.keys as { p256dh: string; auth: string } },
          body,
        );
      } catch (err) {
        log.debug('push delivery failed', { endpoint: subscription.endpoint, error: errorMessage(err) });
      }
    }),
  );
}

async function sendEmail(payload: NotificationPayload): Promise<void> {
  const cfg = config();
  if (!cfg.smtpUrl) return;

  const nodemailer = await import('nodemailer');
  const transport = nodemailer.default.createTransport(cfg.smtpUrl);
  const { getUserById } = await import('../repo/users.js');
  const user = getUserById(payload.userId);
  if (!user) return;

  await transport.sendMail({
    from: cfg.notifyFrom,
    to: user.email,
    subject: payload.title,
    text: `${payload.body}\n\n${payload.url ?? cfg.publicUrl}`,
  });
}

/** "Your spec is ready" — the notification that closes the capture loop (BR-R1). */
export async function notifySpecReady(input: {
  user: User;
  job: Job;
  itemCount: number;
  noContent: boolean;
  reason?: string;
  specId?: string;
}): Promise<void> {
  const { user, job, itemCount, noContent } = input;
  const label = job.title ?? 'your captured link';

  const title = noContent
    ? `Couldn’t read “${label}”`
    : itemCount === 0
      ? `Nothing actionable in “${label}”`
      : `Your spec from “${label}” is ready`;

  const body = noContent
    ? (input.reason ?? 'The content could not be retrieved.')
    : itemCount === 0
      ? 'The post turned out to be commentary rather than advice, so nothing was proposed.'
      : `${itemCount} improvement${itemCount === 1 ? '' : 's'} found — review and approve the ones you want.`;

  await notify(
    {
      userId: user.userId,
      jobId: job.jobId,
      kind: noContent ? 'no_content' : itemCount === 0 ? 'no_items' : 'spec_ready',
      title,
      body,
      url: `${config().publicUrl}/#/job/${job.jobId}`,
    },
    user,
  );
}
