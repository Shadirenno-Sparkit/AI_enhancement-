import type { ItemResult } from '@aiapp/shared';
import { llm } from '../providers/llm.js';
import { audit } from '../repo/audit.js';
import { createLogger } from '../util/logger.js';
import type { HandlerContext, HandlerOutcome } from './handlers.js';
import { AGENTIC_TOOLSETS, type ScopedTool, type ScopedToolOutcome } from './tools.js';

const log = createLogger('agentic');

/**
 * Agentic implementation (spec §4.6).
 *
 * Where a deterministic handler performs one fixed write, this hands the model
 * a toolset scoped to a single approved item and lets it decide how to carry
 * the instruction out — look at what already exists, then write.
 *
 * The autonomy story does not change. Approval still happens first, in the
 * review screen; the trust dial still decides whether an approved item runs
 * unattended; and every tool call passes the same scope check the handlers do,
 * recomputed from the item's *type* rather than anything the model said. A
 * model that reaches for a permission its item does not carry is denied and the
 * attempt is audited — the model is told why, so it can adapt instead of
 * retrying blindly.
 */

/** True when this item can be implemented by the model rather than a fixed handler. */
export function supportsAgentic(ctx: HandlerContext): boolean {
  return llm().live && AGENTIC_TOOLSETS[ctx.item.type] !== undefined;
}

const SYSTEM_PROMPT = `You are carrying out one specific improvement to a user's personal AI setup.

The improvement was extracted from a social media post the user saved, and the user has explicitly
approved this item. Your job is to implement it properly using the tools available.

How to work:
- Look before you write. If a tool lets you list or read what already exists, call it first — silently
  overwriting something the user relies on is the worst outcome here.
- Ground everything in what the post actually said. Never invent capabilities, steps or claims the
  source did not describe. If the source is thin, produce something small and honest rather than
  padding it out.
- Write content that is complete enough to use as-is, not a placeholder or an outline.
- If a tool call is denied, do not retry it. Read the reason, and either accomplish the item a
  different way with the tools you do have, or stop and say plainly what you could not do.
- When you are done, state in one or two sentences what you actually changed. Do not narrate each
  step — the user sees the action log separately.`;

/**
 * Runs one approved item through the model.
 *
 * Returns null when the item has no toolset or no model is configured, so the
 * caller falls back to the deterministic handler rather than failing.
 */
export async function runItemAgentically(ctx: HandlerContext): Promise<HandlerOutcome | null> {
  const build = AGENTIC_TOOLSETS[ctx.item.type];
  if (!build || !llm().live) return null;

  const tools = build(ctx);
  const byName = new Map<string, ScopedTool>(tools.map((tool) => [tool.name, tool]));

  const artifacts: string[] = [];
  const undo: NonNullable<ItemResult['undo']> = [];
  const actions: string[] = [];

  const result = await llm().runAgent({
    system: SYSTEM_PROMPT,
    prompt: describeItem(ctx),
    tools,
    maxTokens: 8192,
    approve: async (call) => {
      const tool = byName.get(call.name);
      if (!tool) {
        // Asking for a tool that was never offered is either confusion or an
        // injected instruction from the post. Both are worth a record.
        log.warn('unknown tool refused', { itemId: ctx.item.itemId, tool: call.name });
        ctx.record('unknown tool refused', call.name, null, false);
        audit({
          userId: ctx.user.userId,
          jobId: ctx.job.jobId,
          itemId: ctx.item.itemId,
          event: 'action.unknown_tool_blocked',
          detail: `model asked for "${call.name}", which this item was not given`,
        });
        return {
          allow: false,
          reason: `There is no tool named "${call.name}". Use only the tools you were given.`,
        };
      }

      // The same containment the handlers get: an item may only use the scopes
      // its type implies. Recomputed server-side, so neither the model nor a
      // tampered row can widen it.
      const missing = tool.scopes.filter((scope) => !ctx.sandbox.has(scope));
      if (missing.length > 0) {
        log.error('scope violation blocked', { itemId: ctx.item.itemId, tool: call.name, missing });
        ctx.record('scope violation blocked', `${call.name} wanted ${missing.join(', ')}`, missing[0]!, false);
        audit({
          userId: ctx.user.userId,
          jobId: ctx.job.jobId,
          itemId: ctx.item.itemId,
          event: 'action.scope_violation_blocked',
          scope: missing[0]!,
          detail: `tool ${call.name} requested ${missing.join(', ')}`,
        });
        return {
          allow: false,
          reason: `This item is not permitted to use ${missing.join(', ')}. Do not retry — use only the tools you were given.`,
        };
      }
      return { allow: true };
    },
    onToolResult: (call, outcome, approved) => {
      if (!approved) {
        actions.push(`Blocked: ${call.name}`);
        return;
      }
      const scoped = outcome as ScopedToolOutcome;
      if (scoped.artifacts) artifacts.push(...scoped.artifacts);
      if (scoped.undo) undo.push(...scoped.undo);
      actions.push(`${call.name}${scoped.isError ? ' (failed)' : ''}`);
    },
  });

  const blocked = result.calls.filter((entry) => !entry.approved);
  const failed = result.calls.filter((entry) => entry.approved && entry.isError);
  const succeeded = result.calls.filter((entry) => entry.approved && !entry.isError);

  log.info('agentic item finished', {
    itemId: ctx.item.itemId,
    calls: result.calls.length,
    blocked: blocked.length,
    failed: failed.length,
    usd: result.usage.usd,
  });

  // Nothing landed. Say so rather than reporting a success with no effect —
  // and let the caller fall back to the deterministic handler.
  if (succeeded.length === 0) return null;

  const status: HandlerOutcome['status'] = ctx.dryRun
    ? 'dry_run'
    : blocked.length > 0 || failed.length > 0
      ? 'partial'
      : 'done';

  return {
    status,
    summary: result.text || `Completed “${ctx.item.title}”.`,
    actions,
    artifacts,
    reversible: undo.length > 0,
    undo: undo.length > 0 ? undo : null,
    needsInput: blocked.length > 0 ? 'Some steps were blocked by this item’s permissions — review the log.' : null,
  };
}

/** The brief the model works from: what to do, why, and where it came from. */
function describeItem(ctx: HandlerContext): string {
  const lines = [
    `Item: ${ctx.item.title}`,
    `Why it matters: ${ctx.item.why}`,
    `Proposed method: ${ctx.item.proposedMethod}`,
    `Source post: ${ctx.job.url}`,
  ];

  const parameters = JSON.stringify(ctx.item.parameters ?? {}, null, 2);
  if (parameters && parameters !== '{}') {
    lines.push('', 'The analyzer drafted these parameters. Treat them as a starting point:', '```json', parameters, '```');
  }
  if (ctx.dryRun) {
    lines.push('', 'This is a PREVIEW run. Call tools as normal — they will report what would change without changing it.');
  }
  return lines.join('\n');
}
