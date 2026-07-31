import type { ItemResult, ItemResultStatus, RunAction, RunStatus, SpecItem } from '@aiapp/shared';
import { audit } from '../repo/audit.js';
import { getJobUnscoped, updateJob } from '../repo/jobs.js';
import { listDecisions, getSpecUnscoped } from '../repo/specs.js';
import { getRunUnscoped, updateRun } from '../repo/runs.js';
import { getUserById, recordUsage } from '../repo/users.js';
import { writeDecisions, writePlan, writeRunLog } from '../artifacts/fileManager.js';
import { createLogger, errorMessage } from '../util/logger.js';
import { HANDLERS, undoItem, type HandlerContext } from './handlers.js';
import { runItemAgentically } from './agentic.js';
import { ScopeViolation, evaluateAutonomy, sandboxFor } from './guardrails.js';

const log = createLogger('engine');

/**
 * Implementation Engine (spec §4.6).
 *
 * Executes approved items one at a time inside a per-item sandbox. Two
 * properties matter most and are enforced here rather than in the handlers:
 *
 *  - **Failure isolation** — an item that throws produces a `not_possible`
 *    result for itself and nothing else (spec §9 "a failure of one item never
 *    silently affects others").
 *  - **Scope containment** — a handler that reaches for a permission its item
 *    type does not carry is stopped by the sandbox and the attempt is audited.
 */
export async function executeRun(runId: string): Promise<void> {
  const run = getRunUnscoped(runId);
  if (!run) {
    log.warn('run disappeared before execution', { runId });
    return;
  }
  if (run.status !== 'queued' && run.status !== 'running') {
    log.debug('run already finished', { runId, status: run.status });
    return;
  }

  const spec = getSpecUnscoped(run.specId);
  const job = getJobUnscoped(run.jobId);
  const user = getUserById(run.userId);
  if (!spec || !job || !user) {
    updateRun(runId, { status: 'failed', overall: 'not_possible', finishedAt: new Date().toISOString() });
    return;
  }

  updateRun(runId, { status: 'running' });
  updateJob(job.jobId, { state: 'IMPLEMENTING', statusMessage: 'Implementing your approved items…' });
  audit({ userId: user.userId, jobId: job.jobId, runId, event: 'run.started', detail: run.dryRun ? 'dry run' : 'live run' });

  const decisions = listDecisions(spec.specId);
  const approved = new Set(decisions.filter((d) => d.decision === 'approve').map((d) => d.itemId));
  const editsByItem = new Map(decisions.map((d) => [d.itemId, d.edits]));

  const actions: RunAction[] = [];
  const results: ItemResult[] = [];

  for (const item of spec.items) {
    if (!approved.has(item.itemId)) {
      // Forgone and deferred items are recorded so the log shows the full
      // picture of what was offered, not just what ran.
      const decision = decisions.find((d) => d.itemId === item.itemId)?.decision ?? 'pending';
      results.push({
        itemId: item.itemId,
        title: item.title,
        type: item.type,
        status: 'skipped',
        summary: decision === 'defer' ? 'Deferred for later — nothing was changed.' : 'You chose to skip this one.',
        actions: [],
        artifacts: [],
        reversible: false,
      });
      continue;
    }

    const decisionForItem = evaluateAutonomy(user, item, run.dryRun);
    if (!decisionForItem.autoImplement) {
      results.push({
        itemId: item.itemId,
        title: item.title,
        type: item.type,
        status: 'needs_input',
        summary: decisionForItem.reason,
        actions: [],
        artifacts: [],
        reversible: false,
        needsInput: 'Confirm this item to let it run.',
      });
      audit({
        userId: user.userId,
        runId,
        itemId: item.itemId,
        event: 'item.held',
        detail: decisionForItem.reason,
      });
      continue;
    }

    // Light edits the user made at approval time override the analyzer's
    // parameters for this run only (BR-R5).
    const edits = editsByItem.get(item.itemId);
    const effectiveItem: SpecItem =
      edits && typeof edits === 'object'
        ? { ...item, parameters: { ...item.parameters, ...(edits as Record<string, unknown>) } }
        : item;

    const result = await runItem({
      item: effectiveItem,
      runId,
      dryRun: decisionForItem.dryRun,
      job,
      user,
      actions,
    });
    results.push(result);

    // Persist incrementally so the review UI can watch progress live.
    updateRun(runId, { items: results, actions });
  }

  const overall = summarize(results);
  const finishedAt = new Date().toISOString();
  const status: RunStatus =
    overall === 'done' ? 'done' : overall === 'needs_input' ? 'needs_input' : overall === 'not_possible' ? 'failed' : 'partial';

  updateRun(runId, { status, items: results, actions, overall, finishedAt });

  updateJob(job.jobId, {
    state: jobStateFor(overall, run.dryRun),
    statusMessage: describeOutcome(results, run.dryRun),
  });

  audit({ userId: user.userId, jobId: job.jobId, runId, event: 'run.finished', detail: `${status} (${overall})` });

  // Refresh the on-disk record now that the run has an outcome.
  if (job.folderName) {
    try {
      const latest = getRunUnscoped(runId)!;
      await writeDecisions(user.userId, job.folderName, spec, decisions);
      await writePlan(user.userId, job.folderName, spec, decisions);
      await writeRunLog(user.userId, job.folderName, latest, spec.items);
    } catch (err) {
      log.error('could not write run artifacts', { runId, error: errorMessage(err) });
    }
  }
}

async function runItem(input: {
  item: SpecItem;
  runId: string;
  dryRun: boolean;
  job: NonNullable<ReturnType<typeof getJobUnscoped>>;
  user: NonNullable<ReturnType<typeof getUserById>>;
  actions: RunAction[];
}): Promise<ItemResult> {
  const { item, runId, dryRun, job, user, actions } = input;
  const sandbox = sandboxFor(item);

  const record = (action: string, detail: string, scope: string | null, ok: boolean): void => {
    const entry: RunAction = {
      at: new Date().toISOString(),
      itemId: item.itemId,
      action,
      detail,
      scope: (scope as RunAction['scope']) ?? null,
      ok,
    };
    actions.push(entry);
    audit({
      userId: user.userId,
      jobId: job.jobId,
      runId,
      itemId: item.itemId,
      event: `action.${action.replace(/\s+/g, '_')}`,
      scope,
      detail,
    });
  };

  const context: HandlerContext = {
    user,
    job,
    item,
    folderName: job.folderName ?? '',
    sandbox,
    dryRun,
    record,
  };

  try {
    if (!job.folderName) throw new Error('this link has no artifact folder yet');

    // Prefer the model when this item type has a toolset and a key is
    // configured: it can inspect what already exists before writing, where a
    // handler can only perform its one fixed action. Falls back to the handler
    // when no model is reachable or the run produced nothing, so behaviour
    // degrades rather than fails.
    const agentic = await runItemAgentically(context).catch((err) => {
      log.warn('agentic implementation failed — falling back to the handler', {
        itemId: item.itemId,
        error: errorMessage(err),
      });
      return null;
    });
    const outcome = agentic ?? (await HANDLERS[item.type](context));

    return {
      itemId: item.itemId,
      title: item.title,
      type: item.type,
      status: outcome.status,
      summary: outcome.summary,
      actions: outcome.actions,
      artifacts: outcome.artifacts,
      reversible: outcome.reversible,
      undo: outcome.undo ?? null,
      needsInput: outcome.needsInput ?? null,
    };
  } catch (err) {
    if (err instanceof ScopeViolation) {
      // A handler asking for a permission its type never grants is a bug or an
      // attack; it is stopped, recorded loudly, and contained to this item.
      log.error('scope violation blocked', { itemId: item.itemId, scope: err.scope });
      record('scope violation blocked', err.message, err.scope, false);
      return {
        itemId: item.itemId,
        title: item.title,
        type: item.type,
        status: 'not_possible',
        summary: 'This item tried to do something outside what it was approved for, so it was stopped.',
        actions: ['Blocked: permission scope violation'],
        artifacts: [],
        reversible: false,
      };
    }

    const message = errorMessage(err);
    log.error('item failed', { itemId: item.itemId, error: message });
    record('item failed', message, null, false);
    return {
      itemId: item.itemId,
      title: item.title,
      type: item.type,
      status: 'not_possible',
      summary: `This one couldn’t be completed: ${message}`,
      actions: [`Failed: ${message}`],
      artifacts: [],
      reversible: false,
    };
  }
}

function summarize(results: ItemResult[]): ItemResultStatus | 'mixed' {
  const active = results.filter((r) => r.status !== 'skipped');
  if (active.length === 0) return 'skipped';

  const statuses = new Set(active.map((r) => r.status));
  if (statuses.size === 1) return [...statuses][0]!;
  if (statuses.has('needs_input')) return 'needs_input';
  if (statuses.has('done') && (statuses.has('not_possible') || statuses.has('partial'))) return 'partial';
  return 'mixed';
}

function jobStateFor(overall: ItemResultStatus | 'mixed', dryRun: boolean): 'DONE' | 'PARTIAL' | 'NEEDS_INPUT' {
  // A preview never claims the work is finished.
  if (dryRun) return 'NEEDS_INPUT';
  if (overall === 'done') return 'DONE';
  if (overall === 'needs_input') return 'NEEDS_INPUT';
  return 'PARTIAL';
}

function describeOutcome(results: ItemResult[], dryRun: boolean): string {
  if (dryRun) return 'Preview complete — review what would change, then run it for real.';
  const done = results.filter((r) => r.status === 'done').length;
  const needs = results.filter((r) => r.status === 'needs_input').length;
  const failed = results.filter((r) => r.status === 'not_possible').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

  const parts: string[] = [];
  if (done) parts.push(`${done} implemented`);
  if (needs) parts.push(`${needs} needs you`);
  if (failed) parts.push(`${failed} not possible`);
  if (skipped) parts.push(`${skipped} skipped`);
  return parts.length ? parts.join(' · ') : 'Nothing to do.';
}

/**
 * Reverts an implemented item where the run recorded how (BR-I6).
 * Returns the human-readable steps that were undone.
 */
export async function revertItem(runId: string, itemId: string): Promise<{ ok: boolean; steps: string[] }> {
  const run = getRunUnscoped(runId);
  if (!run) return { ok: false, steps: [] };

  const result = run.items.find((item) => item.itemId === itemId);
  if (!result || !result.reversible || !result.undo || result.undo.length === 0) {
    return { ok: false, steps: [] };
  }

  const steps = await undoItem(result.undo);
  const items = run.items.map((item) =>
    item.itemId === itemId
      ? {
          ...item,
          status: 'skipped' as const,
          summary: 'Reverted at your request.',
          actions: [...item.actions, 'Reverted'],
          reversible: false,
          undo: null,
        }
      : item,
  );
  updateRun(runId, { items });
  audit({ userId: run.userId, runId, itemId, event: 'item.reverted', detail: steps.join('; ') });
  recordUsage(run.userId, {});
  return { ok: true, steps };
}
