import { db, now, parseJson } from '../db/index.js';
import { id } from '../util/ids.js';

export interface ScheduledTask {
  taskId: string;
  userId: string;
  itemId: string | null;
  name: string;
  cron: string;
  timezone: string;
  action: Record<string, unknown>;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
}

interface Row {
  task_id: string;
  user_id: string;
  item_id: string | null;
  name: string;
  cron: string;
  timezone: string;
  action: string;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
}

const toTask = (r: Row): ScheduledTask => ({
  taskId: r.task_id,
  userId: r.user_id,
  itemId: r.item_id,
  name: r.name,
  cron: r.cron,
  timezone: r.timezone,
  action: parseJson<Record<string, unknown>>(r.action, {}),
  enabled: r.enabled === 1,
  nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at,
  createdAt: r.created_at,
});

export function createScheduledTask(input: {
  userId: string;
  itemId?: string | null;
  name: string;
  cron: string;
  timezone?: string;
  action: Record<string, unknown>;
  nextRunAt?: string | null;
}): ScheduledTask {
  const taskId = id('sch');
  db()
    .prepare(
      `INSERT INTO scheduled_tasks (task_id, user_id, item_id, name, cron, timezone, action, enabled, next_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      taskId,
      input.userId,
      input.itemId ?? null,
      input.name,
      input.cron,
      input.timezone ?? 'UTC',
      JSON.stringify(input.action),
      input.nextRunAt ?? null,
      now(),
    );
  return getScheduledTask(taskId)!;
}

export function getScheduledTask(taskId: string): ScheduledTask | null {
  const row = db().prepare('SELECT * FROM scheduled_tasks WHERE task_id = ?').get(taskId) as Row | undefined;
  return row ? toTask(row) : null;
}

export function listScheduledTasks(userId: string): ScheduledTask[] {
  const rows = db()
    .prepare('SELECT * FROM scheduled_tasks WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as Row[];
  return rows.map(toTask);
}

export function setScheduledTaskEnabled(taskId: string, userId: string, enabled: boolean): boolean {
  return (
    db()
      .prepare('UPDATE scheduled_tasks SET enabled = ? WHERE task_id = ? AND user_id = ?')
      .run(enabled ? 1 : 0, taskId, userId).changes > 0
  );
}

/** Used by the undo path when a schedule_task item is reverted (BR-I6). */
export function deleteScheduledTask(taskId: string): boolean {
  return db().prepare('DELETE FROM scheduled_tasks WHERE task_id = ?').run(taskId).changes > 0;
}

export function deleteScheduledTasksForItem(itemId: string): number {
  return db().prepare('DELETE FROM scheduled_tasks WHERE item_id = ?').run(itemId).changes;
}
