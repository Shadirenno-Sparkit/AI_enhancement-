import { config } from '../config.js';
import { executeRun } from '../implementation/engine.js';
import { nextRunFor, parseCron, cronMatches } from '../implementation/cron.js';
import { failJob, processJob } from '../orchestrator/pipeline.js';
import { purgeExpiredMedia } from '../artifacts/fileManager.js';
import { deliver, notify } from '../notifications/notify.js';
import { clearDeferral, dueDeferredNotifications } from '../repo/notifications.js';
import { db } from '../db/index.js';
import { incrementAttempts } from '../repo/jobs.js';
import { listScheduledTasks } from '../repo/schedules.js';
import { createLogger, errorMessage } from '../util/logger.js';
import { claim, complete, fail, type QueueItem } from './queue.js';

const log = createLogger('worker');

/** Idle poll interval. Short enough to feel instant, cheap enough to leave running. */
const IDLE_POLL_MS = 750;
/** Housekeeping cadence: schedules, deferred notifications, media retention. */
const TICK_MS = 60_000;

export async function handleQueueItem(item: QueueItem): Promise<void> {
  if (item.kind === 'process') {
    incrementAttempts(item.jobId);
    await processJob(item.jobId, { force: item.payload['force'] === true });
    return;
  }
  if (item.kind === 'implement') {
    const runId = item.payload['runId'];
    if (typeof runId !== 'string') throw new Error('implement job is missing runId');
    await executeRun(runId);
    return;
  }
  throw new Error(`Unknown queue item kind: ${item.kind}`);
}

export class Worker {
  private running = false;
  private loops: Promise<void>[] = [];
  private tickTimer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.running) return;
    this.running = true;

    const concurrency = Math.max(1, config().workerConcurrency);
    for (let i = 0; i < concurrency; i++) this.loops.push(this.loop(i));

    this.tickTimer = setInterval(() => {
      void this.tick().catch((err) => log.warn('housekeeping tick failed', { error: errorMessage(err) }));
    }, TICK_MS);
    // Housekeeping must never keep the process alive on its own.
    this.tickTimer.unref?.();

    log.info('worker started', { concurrency });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    await Promise.allSettled(this.loops);
    this.loops = [];
  }

  private async loop(index: number): Promise<void> {
    const workerLog = log.child(`w${index}`);
    while (this.running) {
      let item: QueueItem | null = null;
      try {
        item = claim();
      } catch (err) {
        workerLog.error('could not claim work', { error: errorMessage(err) });
      }

      if (!item) {
        await sleep(IDLE_POLL_MS);
        continue;
      }

      try {
        await handleQueueItem(item);
        complete(item.queueId);
      } catch (err) {
        const message = errorMessage(err);
        const willRetry = fail(item.queueId, message);
        workerLog.error('queue item failed', {
          queueId: item.queueId,
          jobId: item.jobId,
          attempt: item.attempts,
          willRetry,
          error: message,
        });
        // Only surface the failure to the user once retries are genuinely spent.
        if (!willRetry && item.kind === 'process') failJob(item.jobId, message);
      }
    }
  }

  /** Periodic work that is not tied to a queued item. */
  private async tick(): Promise<void> {
    await this.releaseDeferredNotifications();
    await this.runDueSchedules();
    await this.purgeMedia();
  }

  private async releaseDeferredNotifications(): Promise<void> {
    for (const record of dueDeferredNotifications()) {
      clearDeferral(record.notificationId);
      await deliver(
        record.notificationId,
        {
          userId: record.userId,
          jobId: record.jobId,
          kind: record.kind,
          title: record.title,
          body: record.body,
        },
        config().notifyChannels,
      );
    }
  }

  /**
   * Fires scheduled tasks whose cron matches this minute (BR-I5).
   * `nextRunAt` is advanced first so a slow delivery cannot double-fire.
   */
  private async runDueSchedules(): Promise<void> {
    const userIds = (db().prepare('SELECT DISTINCT user_id FROM scheduled_tasks WHERE enabled = 1').all() as {
      user_id: string;
    }[]).map((row) => row.user_id);

    const now = new Date();
    for (const userId of userIds) {
      for (const task of listScheduledTasks(userId)) {
        if (!task.enabled) continue;
        const fields = parseCron(task.cron);
        if (!fields) continue;

        const due = task.nextRunAt ? new Date(task.nextRunAt) <= now : cronMatches(fields, now);
        if (!due) continue;

        const next = nextRunFor(task.cron, now);
        db()
          .prepare('UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = ? WHERE task_id = ?')
          .run(now.toISOString(), next, task.taskId);

        const description = typeof task.action['description'] === 'string' ? task.action['description'] : task.name;
        await notify({
          userId,
          kind: 'scheduled_task',
          title: `Scheduled: ${task.name}`,
          body: description,
        });
        log.info('scheduled task fired', { taskId: task.taskId, name: task.name });
      }
    }
  }

  private async purgeMedia(): Promise<void> {
    const cfg = config();
    if (cfg.mediaRetentionDays <= 0) return;
    // Once an hour is plenty for a retention sweep.
    if (new Date().getUTCMinutes() !== 7) return;

    const userIds = (db().prepare('SELECT user_id FROM users').all() as { user_id: string }[]).map((r) => r.user_id);
    for (const userId of userIds) {
      await purgeExpiredMedia(userId, cfg.mediaRetentionDays).catch((err) =>
        log.warn('media purge failed', { userId, error: errorMessage(err) }),
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
