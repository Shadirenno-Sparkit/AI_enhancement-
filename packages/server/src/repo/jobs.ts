import type { CaptureSource, Job, JobState, Platform } from '@aiapp/shared';
import { JOB_STATE_ORDER, TERMINAL_JOB_STATES } from '@aiapp/shared';
import { db, now } from '../db/index.js';
import { id, idempotencyKey } from '../util/ids.js';

interface JobRow {
  job_id: string;
  user_id: string;
  url: string;
  normalized_url: string;
  idempotency_key: string;
  shared_text: string | null;
  note: string | null;
  platform: string;
  state: string;
  status_message: string | null;
  title: string | null;
  capture_source: string;
  folder_name: string | null;
  cost_asr_seconds: number;
  cost_model_tokens: number;
  cost_usd: number;
  attempts: number;
  created_at: string;
  updated_at: string;
}

function toJob(row: JobRow): Job {
  return {
    jobId: row.job_id,
    userId: row.user_id,
    url: row.url,
    normalizedUrl: row.normalized_url,
    sharedText: row.shared_text,
    note: row.note,
    platform: row.platform as Platform,
    state: row.state as JobState,
    statusMessage: row.status_message,
    title: row.title,
    captureSource: row.capture_source as CaptureSource,
    folderName: row.folder_name,
    cost: {
      asrSeconds: row.cost_asr_seconds,
      modelTokens: row.cost_model_tokens,
      usd: Number(row.cost_usd.toFixed(6)),
    },
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateJobInput {
  userId: string;
  url: string;
  normalizedUrl: string;
  platform: Platform;
  sharedText?: string | null;
  note?: string | null;
  captureSource: CaptureSource;
}

/**
 * Inserts a job, or returns the existing one for a duplicate share.
 *
 * Dedupe is on `hash(userId + normalizedUrl)` (spec §5.3) so re-sharing the
 * same Reel from a different app — with different tracking params — folds into
 * the original job instead of paying to process it twice.
 */
export function createOrGetJob(input: CreateJobInput): { job: Job; deduped: boolean } {
  const key = idempotencyKey(input.userId, input.normalizedUrl);
  const existing = db()
    .prepare('SELECT * FROM jobs WHERE user_id = ? AND idempotency_key = ?')
    .get(input.userId, key) as JobRow | undefined;
  if (existing) return { job: toJob(existing), deduped: true };

  const jobId = id('job');
  const timestamp = now();
  db()
    .prepare(
      `INSERT INTO jobs (job_id, user_id, url, normalized_url, idempotency_key, shared_text, note,
                         platform, state, capture_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?, ?)`,
    )
    .run(
      jobId,
      input.userId,
      input.url,
      input.normalizedUrl,
      key,
      input.sharedText ?? null,
      input.note ?? null,
      input.platform,
      input.captureSource,
      timestamp,
      timestamp,
    );
  return { job: getJob(jobId, input.userId)!, deduped: false };
}

/** Every read is scoped by user_id — per-user isolation is enforced here. */
export function getJob(jobId: string, userId: string): Job | null {
  const row = db()
    .prepare('SELECT * FROM jobs WHERE job_id = ? AND user_id = ?')
    .get(jobId, userId) as JobRow | undefined;
  return row ? toJob(row) : null;
}

/** Worker-side read that has already established ownership via the queue row. */
export function getJobUnscoped(jobId: string): Job | null {
  const row = db().prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as JobRow | undefined;
  return row ? toJob(row) : null;
}

export function listJobs(userId: string, limit = 100, offset = 0): Job[] {
  const rows = db()
    .prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(userId, limit, offset) as JobRow[];
  return rows.map(toJob);
}

export interface JobUpdate {
  state?: JobState;
  statusMessage?: string | null;
  title?: string | null;
  folderName?: string | null;
  platform?: Platform;
}

/**
 * Applies a state transition. Backwards moves are ignored unless the target is
 * terminal, so a late-arriving retry can never rewind a finished job.
 */
export function updateJob(jobId: string, patch: JobUpdate): Job | null {
  const current = getJobUnscoped(jobId);
  if (!current) return null;

  let nextState = current.state;
  if (patch.state) {
    const isTerminal = TERMINAL_JOB_STATES.includes(patch.state);
    const forward = JOB_STATE_ORDER[patch.state] >= JOB_STATE_ORDER[current.state];
    const currentTerminal = TERMINAL_JOB_STATES.includes(current.state);
    if (isTerminal || (forward && !currentTerminal)) nextState = patch.state;
  }

  db()
    .prepare(
      `UPDATE jobs SET state = ?, status_message = ?, title = ?, folder_name = ?, platform = ?, updated_at = ?
       WHERE job_id = ?`,
    )
    .run(
      nextState,
      patch.statusMessage !== undefined ? patch.statusMessage : current.statusMessage,
      patch.title !== undefined ? patch.title : current.title,
      patch.folderName !== undefined ? patch.folderName : current.folderName,
      patch.platform ?? current.platform,
      now(),
      jobId,
    );
  return getJobUnscoped(jobId);
}

export function addJobCost(
  jobId: string,
  delta: { asrSeconds?: number; modelTokens?: number; usd?: number },
): void {
  db()
    .prepare(
      `UPDATE jobs SET cost_asr_seconds = cost_asr_seconds + ?,
                       cost_model_tokens = cost_model_tokens + ?,
                       cost_usd = cost_usd + ?,
                       updated_at = ?
       WHERE job_id = ?`,
    )
    .run(delta.asrSeconds ?? 0, delta.modelTokens ?? 0, delta.usd ?? 0, now(), jobId);
}

export function incrementAttempts(jobId: string): void {
  db().prepare('UPDATE jobs SET attempts = attempts + 1, updated_at = ? WHERE job_id = ?').run(now(), jobId);
}

export function deleteJob(jobId: string, userId: string): boolean {
  const result = db().prepare('DELETE FROM jobs WHERE job_id = ? AND user_id = ?').run(jobId, userId);
  return result.changes > 0;
}

/** Jobs captured in the last N days, for the weekly digest. */
export function jobsSince(userId: string, sinceIso: string): Job[] {
  const rows = db()
    .prepare('SELECT * FROM jobs WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC')
    .all(userId, sinceIso) as JobRow[];
  return rows.map(toJob);
}
