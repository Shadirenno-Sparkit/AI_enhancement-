import type { ImplementationRun, ItemResult, ItemResultStatus, RunAction, RunStatus } from '@aiapp/shared';
import { db, now, parseJson } from '../db/index.js';
import { id } from '../util/ids.js';

interface RunRow {
  run_id: string;
  spec_id: string;
  job_id: string;
  user_id: string;
  status: string;
  dry_run: number;
  items: string;
  actions: string;
  overall: string | null;
  started_at: string;
  finished_at: string | null;
}

function toRun(row: RunRow): ImplementationRun {
  return {
    runId: row.run_id,
    specId: row.spec_id,
    jobId: row.job_id,
    userId: row.user_id,
    status: row.status as RunStatus,
    dryRun: row.dry_run === 1,
    items: parseJson<ItemResult[]>(row.items, []),
    actions: parseJson<RunAction[]>(row.actions, []),
    overall: (row.overall as ItemResult['status'] | 'mixed' | null) ?? null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function createRun(input: {
  specId: string;
  jobId: string;
  userId: string;
  dryRun: boolean;
}): ImplementationRun {
  const runId = id('run');
  db()
    .prepare(
      `INSERT INTO runs (run_id, spec_id, job_id, user_id, status, dry_run, items, actions, started_at)
       VALUES (?, ?, ?, ?, 'queued', ?, '[]', '[]', ?)`,
    )
    .run(runId, input.specId, input.jobId, input.userId, input.dryRun ? 1 : 0, now());
  return getRunUnscoped(runId)!;
}

export function getRun(runId: string, userId: string): ImplementationRun | null {
  const row = db()
    .prepare('SELECT * FROM runs WHERE run_id = ? AND user_id = ?')
    .get(runId, userId) as RunRow | undefined;
  return row ? toRun(row) : null;
}

export function getRunUnscoped(runId: string): ImplementationRun | null {
  const row = db().prepare('SELECT * FROM runs WHERE run_id = ?').get(runId) as RunRow | undefined;
  return row ? toRun(row) : null;
}

export function latestRunForSpec(specId: string): ImplementationRun | null {
  const row = db()
    .prepare('SELECT * FROM runs WHERE spec_id = ? ORDER BY started_at DESC LIMIT 1')
    .get(specId) as RunRow | undefined;
  return row ? toRun(row) : null;
}

export function updateRun(
  runId: string,
  patch: {
    status?: RunStatus;
    items?: ItemResult[];
    actions?: RunAction[];
    overall?: ItemResultStatus | 'mixed' | null;
    finishedAt?: string | null;
  },
): ImplementationRun | null {
  const current = getRunUnscoped(runId);
  if (!current) return null;
  db()
    .prepare('UPDATE runs SET status = ?, items = ?, actions = ?, overall = ?, finished_at = ? WHERE run_id = ?')
    .run(
      patch.status ?? current.status,
      JSON.stringify(patch.items ?? current.items),
      JSON.stringify(patch.actions ?? current.actions),
      patch.overall !== undefined ? patch.overall : current.overall,
      patch.finishedAt !== undefined ? patch.finishedAt : current.finishedAt,
      runId,
    );
  return getRunUnscoped(runId);
}

/** Appends one action to the run log without rewriting the rest. BR-I4. */
export function appendRunAction(runId: string, action: RunAction): void {
  const current = getRunUnscoped(runId);
  if (!current) return;
  const actions = [...current.actions, action];
  db().prepare('UPDATE runs SET actions = ? WHERE run_id = ?').run(JSON.stringify(actions), runId);
}

export function listRunsForUser(userId: string, limit = 50): ImplementationRun[] {
  const rows = db()
    .prepare('SELECT * FROM runs WHERE user_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(userId, limit) as RunRow[];
  return rows.map(toRun);
}
