import type { PermissionScope } from '@aiapp/shared';
import { db, now } from '../db/index.js';

export interface AuditEvent {
  userId?: string | null;
  jobId?: string | null;
  runId?: string | null;
  itemId?: string | null;
  event: string;
  scope?: PermissionScope | string | null;
  detail?: string | null;
}

/**
 * Append-only record of autonomous actions and security-relevant events
 * (BR-I4, spec §4.7). Nothing in the codebase updates or deletes these rows;
 * the only mutation is de-identification on account erasure.
 */
export function audit(event: AuditEvent): void {
  db()
    .prepare(
      `INSERT INTO audit_log (user_id, job_id, run_id, item_id, event, scope, detail, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.userId ?? null,
      event.jobId ?? null,
      event.runId ?? null,
      event.itemId ?? null,
      event.event,
      event.scope ?? null,
      event.detail ?? null,
      now(),
    );
}

export interface AuditRow {
  auditId: number;
  userId: string | null;
  jobId: string | null;
  runId: string | null;
  itemId: string | null;
  event: string;
  scope: string | null;
  detail: string | null;
  at: string;
}

export function listAudit(userId: string, limit = 200): AuditRow[] {
  const rows = db()
    .prepare('SELECT * FROM audit_log WHERE user_id = ? ORDER BY audit_id DESC LIMIT ?')
    .all(userId, limit) as Record<string, never>[];
  return rows.map((r) => ({
    auditId: r['audit_id'] as unknown as number,
    userId: r['user_id'] as unknown as string | null,
    jobId: r['job_id'] as unknown as string | null,
    runId: r['run_id'] as unknown as string | null,
    itemId: r['item_id'] as unknown as string | null,
    event: r['event'] as unknown as string,
    scope: r['scope'] as unknown as string | null,
    detail: r['detail'] as unknown as string | null,
    at: r['at'] as unknown as string,
  }));
}

export function listAuditForRun(runId: string): AuditRow[] {
  const rows = db().prepare('SELECT * FROM audit_log WHERE run_id = ? ORDER BY audit_id ASC').all(runId) as Record<
    string,
    never
  >[];
  return rows.map((r) => ({
    auditId: r['audit_id'] as unknown as number,
    userId: r['user_id'] as unknown as string | null,
    jobId: r['job_id'] as unknown as string | null,
    runId: r['run_id'] as unknown as string | null,
    itemId: r['item_id'] as unknown as string | null,
    event: r['event'] as unknown as string,
    scope: r['scope'] as unknown as string | null,
    detail: r['detail'] as unknown as string | null,
    at: r['at'] as unknown as string,
  }));
}
