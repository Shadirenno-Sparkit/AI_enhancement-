import { db, now, parseJson } from '../db/index.js';
import { randomToken } from '../util/ids.js';

export type QueueKind = 'process' | 'implement';

export interface QueueItem {
  queueId: number;
  jobId: string;
  kind: QueueKind;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

interface Row {
  queue_id: number;
  job_id: string;
  kind: string;
  payload: string;
  attempts: number;
  max_attempts: number;
}

/** How long a leased row stays invisible before another worker may claim it. */
const LEASE_SECONDS = 300;

/** Exponential backoff between attempts, in seconds. Spec §5.4 retries. */
const BACKOFF_SECONDS = [5, 30, 120, 600];

export function enqueue(input: {
  jobId: string;
  kind: QueueKind;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  delaySeconds?: number;
}): number {
  const runAfter = new Date(Date.now() + (input.delaySeconds ?? 0) * 1000).toISOString();
  const timestamp = now();
  const result = db()
    .prepare(
      `INSERT INTO job_queue (job_id, kind, payload, status, attempts, max_attempts, run_after, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
    )
    .run(
      input.jobId,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.maxAttempts ?? 3,
      runAfter,
      timestamp,
      timestamp,
    );
  return Number(result.lastInsertRowid);
}

/**
 * Atomically claims one ready row.
 *
 * The UPDATE ... WHERE queue_id = (SELECT ... LIMIT 1) form is what makes this
 * safe across concurrent workers: SQLite serializes the write, so exactly one
 * worker wins the lease. Rows whose lease has expired become claimable again,
 * which is how a crashed worker's job resumes (spec §5.4 "restarts resume cleanly").
 */
export function claim(): QueueItem | null {
  const owner = randomToken(8);
  const timestamp = now();
  const leaseUntil = new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();

  const claimed = db().transaction((): Row | undefined => {
    const result = db()
      .prepare(
        `UPDATE job_queue
            SET status = 'leased', lease_owner = ?, leased_until = ?, attempts = attempts + 1, updated_at = ?
          WHERE queue_id = (
            SELECT queue_id FROM job_queue
             WHERE run_after <= ?
               AND (status = 'pending' OR (status = 'leased' AND leased_until < ?))
             ORDER BY queue_id ASC
             LIMIT 1
          )`,
      )
      .run(owner, leaseUntil, timestamp, timestamp, timestamp);
    if (result.changes === 0) return undefined;
    return db()
      .prepare('SELECT * FROM job_queue WHERE lease_owner = ? AND status = ? LIMIT 1')
      .get(owner, 'leased') as Row | undefined;
  })();

  if (!claimed) return null;
  return {
    queueId: claimed.queue_id,
    jobId: claimed.job_id,
    kind: claimed.kind as QueueKind,
    payload: parseJson<Record<string, unknown>>(claimed.payload, {}),
    attempts: claimed.attempts,
    maxAttempts: claimed.max_attempts,
  };
}

export function complete(queueId: number): void {
  db()
    .prepare("UPDATE job_queue SET status = 'done', leased_until = NULL, lease_owner = NULL, updated_at = ? WHERE queue_id = ?")
    .run(now(), queueId);
}

/**
 * Records a failure. Returns true when the item will be retried, false when
 * attempts are exhausted and the caller should mark the job FAILED.
 */
export function fail(queueId: number, error: string): boolean {
  const row = db()
    .prepare('SELECT attempts, max_attempts FROM job_queue WHERE queue_id = ?')
    .get(queueId) as { attempts: number; max_attempts: number } | undefined;
  if (!row) return false;

  const willRetry = row.attempts < row.max_attempts;
  if (willRetry) {
    const backoff = BACKOFF_SECONDS[Math.min(row.attempts - 1, BACKOFF_SECONDS.length - 1)] ?? 600;
    db()
      .prepare(
        `UPDATE job_queue SET status = 'pending', run_after = ?, leased_until = NULL, lease_owner = NULL,
                              last_error = ?, updated_at = ? WHERE queue_id = ?`,
      )
      .run(new Date(Date.now() + backoff * 1000).toISOString(), error.slice(0, 2000), now(), queueId);
  } else {
    db()
      .prepare(
        `UPDATE job_queue SET status = 'failed', leased_until = NULL, lease_owner = NULL,
                              last_error = ?, updated_at = ? WHERE queue_id = ?`,
      )
      .run(error.slice(0, 2000), now(), queueId);
  }
  return willRetry;
}

export function queueDepth(): { pending: number; leased: number; failed: number } {
  const rows = db().prepare('SELECT status, COUNT(*) AS n FROM job_queue GROUP BY status').all() as {
    status: string;
    n: number;
  }[];
  const out = { pending: 0, leased: 0, failed: 0 };
  for (const row of rows) {
    if (row.status === 'pending') out.pending = row.n;
    else if (row.status === 'leased') out.leased = row.n;
    else if (row.status === 'failed') out.failed = row.n;
  }
  return out;
}

/** Test/ops helper: drains every ready item using the supplied handler. */
export async function drain(
  handler: (item: QueueItem) => Promise<void>,
  maxItems = 100,
): Promise<number> {
  let processed = 0;
  for (let i = 0; i < maxItems; i++) {
    const item = claim();
    if (!item) break;
    try {
      await handler(item);
      complete(item.queueId);
    } catch (err) {
      fail(item.queueId, err instanceof Error ? err.message : String(err));
    }
    processed++;
  }
  return processed;
}
