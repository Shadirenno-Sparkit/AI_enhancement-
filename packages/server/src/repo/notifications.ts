import { db, now } from '../db/index.js';
import { id } from '../util/ids.js';

export interface NotificationRecord {
  notificationId: string;
  userId: string;
  jobId: string | null;
  kind: string;
  title: string;
  body: string;
  read: boolean;
  deferredUntil: string | null;
  createdAt: string;
}

interface Row {
  notification_id: string;
  user_id: string;
  job_id: string | null;
  kind: string;
  title: string;
  body: string;
  read: number;
  deferred_until: string | null;
  created_at: string;
}

const toRecord = (r: Row): NotificationRecord => ({
  notificationId: r.notification_id,
  userId: r.user_id,
  jobId: r.job_id,
  kind: r.kind,
  title: r.title,
  body: r.body,
  read: r.read === 1,
  deferredUntil: r.deferred_until,
  createdAt: r.created_at,
});

export function insertNotification(input: {
  userId: string;
  jobId?: string | null;
  kind: string;
  title: string;
  body: string;
  deferredUntil?: string | null;
}): NotificationRecord {
  const notificationId = id('ntf');
  db()
    .prepare(
      `INSERT INTO notifications (notification_id, user_id, job_id, kind, title, body, deferred_until, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      notificationId,
      input.userId,
      input.jobId ?? null,
      input.kind,
      input.title,
      input.body,
      input.deferredUntil ?? null,
      now(),
    );
  return getNotification(notificationId)!;
}

function getNotification(notificationId: string): NotificationRecord | null {
  const row = db()
    .prepare('SELECT * FROM notifications WHERE notification_id = ?')
    .get(notificationId) as Row | undefined;
  return row ? toRecord(row) : null;
}

export function listNotifications(userId: string, limit = 50): NotificationRecord[] {
  const rows = db()
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit) as Row[];
  return rows.map(toRecord);
}

export function markNotificationsRead(userId: string, ids?: string[]): number {
  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    return db()
      .prepare(`UPDATE notifications SET read = 1 WHERE user_id = ? AND notification_id IN (${placeholders})`)
      .run(userId, ...ids).changes;
  }
  return db().prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(userId).changes;
}

/** Notifications held by quiet hours whose window has now passed. */
export function dueDeferredNotifications(): NotificationRecord[] {
  const rows = db()
    .prepare('SELECT * FROM notifications WHERE deferred_until IS NOT NULL AND deferred_until <= ?')
    .all(now()) as Row[];
  return rows.map(toRecord);
}

export function clearDeferral(notificationId: string): void {
  db().prepare('UPDATE notifications SET deferred_until = NULL WHERE notification_id = ?').run(notificationId);
}

// ─── Web push subscriptions ──────────────────────────────────────────────────

export function savePushSubscription(userId: string, endpoint: string, keys: unknown): void {
  db()
    .prepare(
      `INSERT INTO push_subscriptions (subscription_id, user_id, endpoint, keys, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, endpoint) DO UPDATE SET keys = excluded.keys`,
    )
    .run(id('sub'), userId, endpoint, JSON.stringify(keys), now());
}

export function listPushSubscriptions(userId: string): { endpoint: string; keys: Record<string, string> }[] {
  const rows = db()
    .prepare('SELECT endpoint, keys FROM push_subscriptions WHERE user_id = ?')
    .all(userId) as { endpoint: string; keys: string }[];
  return rows.map((r) => ({
    endpoint: r.endpoint,
    keys: JSON.parse(r.keys) as Record<string, string>,
  }));
}

export function deletePushSubscription(userId: string, endpoint: string): void {
  db().prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint);
}
