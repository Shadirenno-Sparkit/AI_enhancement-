import type { ItemResultStatus } from '@aiapp/shared';
import { writeItemArtifact, sanitizeFilename } from '../artifacts/fileManager.js';
import { createScheduledTask } from '../repo/schedules.js';
import { nextRunFor } from './cron.js';
import type { HandlerContext, HandlerOutcome } from './handlers.js';

/**
 * Handlers for the life-domain item types (spec §4.6b).
 *
 * These act outside the user's AI environment — on what they read, buy, practise
 * and who they talk to. Every one of them stops one step short of the
 * irreversible act:
 *
 *   - `acquire_media` and `purchase` prepare an order and hand back the link.
 *   - `contact_person` writes a draft and never sends it.
 *   - `financial_review` produces questions, never a transaction.
 *
 * That line is deliberate and is enforced twice: by the scopes these item types
 * carry (none of them can reach a payment or send path, because no such scope
 * exists), and by the handlers themselves never attempting it. An assistant that
 * can spend your money while you scroll is not a product anyone should ship.
 */

function str(parameters: Record<string, unknown>, key: string): string | null {
  const value = parameters[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function strArray(parameters: Record<string, unknown>, key: string): string[] {
  const value = parameters[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0) : [];
}

function num(parameters: Record<string, unknown>, key: string): number | null {
  const value = parameters[key];
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function slug(ctx: HandlerContext, fallback: string): string {
  return sanitizeFilename(
    ctx.item.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback,
  ).replace(/\.md$/, '');
}

/** Shared shape for handlers whose product is a markdown document. */
async function writeDocument(input: {
  ctx: HandlerContext;
  filename: string;
  content: string;
  scope: 'commerce:prepare' | 'outbox:draft' | 'artifacts:write' | 'net:read' | 'schedule:write';
  verb: string;
  summary: (path: string) => string;
  status?: ItemResultStatus;
  needsInput?: string;
}): Promise<HandlerOutcome> {
  const { ctx, filename, content, scope, verb, summary } = input;

  if (ctx.dryRun) {
    ctx.record(`would ${verb}`, `${filename} (${content.length} bytes)`, scope, true);
    return {
      status: 'dry_run',
      summary: `Would ${verb} — ${filename}, ${content.length} bytes.`,
      actions: [`Preview: ${verb}`],
      artifacts: [],
      reversible: true,
    };
  }

  const artifactPath = await writeItemArtifact(ctx.user.userId, ctx.folderName, filename, content);
  ctx.record(verb, filename, scope, true);
  return {
    status: input.status ?? 'done',
    summary: summary(artifactPath),
    actions: [verb.charAt(0).toUpperCase() + verb.slice(1)],
    artifacts: [artifactPath],
    reversible: true,
    undo: [{ kind: 'delete_file', target: artifactPath }],
    needsInput: input.needsInput ?? null,
  };
}

// ─── acquire_media ───────────────────────────────────────────────────────────

/**
 * The audiobook case from the brief: the same book, routed to the format the
 * person actually consumes. The item carries `format` chosen by the analyzer
 * from their profile, and `why_this_format` explains the choice back to them.
 */
export const acquireMedia = async (ctx: HandlerContext): Promise<HandlerOutcome> => {
  ctx.sandbox.require('commerce:prepare');
  ctx.sandbox.require('artifacts:write');

  const parameters = ctx.item.parameters;
  const title = str(parameters, 'title') ?? ctx.item.title;
  const author = str(parameters, 'author');
  const format = str(parameters, 'format') ?? 'ebook';
  const where = str(parameters, 'where');
  const cost = num(parameters, 'estimatedCostUsd');
  const whyFormat = str(parameters, 'why_this_format');

  const searchQuery = encodeURIComponent([title, author].filter(Boolean).join(' '));
  // Search links rather than product links: a direct product URL guessed by a
  // model is frequently wrong, and sending someone to the wrong item is worse
  // than sending them to a search that certainly contains the right one.
  const links: Record<string, string> = {
    audiobook: `https://www.audible.com/search?keywords=${searchQuery}`,
    ebook: `https://www.amazon.com/s?k=${searchQuery}&i=digital-text`,
    print: `https://bookshop.org/search?keywords=${searchQuery}`,
    course: `https://www.google.com/search?q=${searchQuery}+course`,
  };
  const link = where && /^https?:\/\//i.test(where) ? where : (links[format] ?? links['ebook']!);

  const content = [
    `# ${title}`,
    '',
    author ? `**By:** ${author}` : '',
    `**Format:** ${format}`,
    cost !== null ? `**Estimated cost:** $${cost.toFixed(2)}` : '',
    '',
    whyFormat ? `## Why this format\n\n${whyFormat}\n` : '',
    '## Get it',
    '',
    `[Find it here](${link})`,
    '',
    where && !/^https?:\/\//i.test(where) ? `Suggested source: ${where}` : '',
    '',
    '## Why it came up',
    '',
    ctx.item.why,
    '',
    '---',
    '',
    '*Nothing has been ordered. This is a prepared decision — you place the order.*',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return writeDocument({
    ctx,
    filename: `${slug(ctx, 'media')}.md`,
    content,
    scope: 'commerce:prepare',
    verb: 'prepared the order',
    status: 'done',
    needsInput: 'Open the link and order it when you want it.',
    summary: (path) =>
      `Ready to order “${title}”${author ? ` by ${author}` : ''} as ${format === 'audiobook' ? 'an' : 'a'} ${format}` +
      `${cost !== null ? ` (about $${cost.toFixed(2)})` : ''}. Link saved to \`${path}\` — nothing was bought.`,
  });
};

// ─── purchase ────────────────────────────────────────────────────────────────

export const purchase = async (ctx: HandlerContext): Promise<HandlerOutcome> => {
  ctx.sandbox.require('commerce:prepare');
  ctx.sandbox.require('artifacts:write');

  const parameters = ctx.item.parameters;
  const what = str(parameters, 'item') ?? ctx.item.title;
  const cost = num(parameters, 'estimatedCostUsd');
  const where = str(parameters, 'where');
  const checkFirst = strArray(parameters, 'checkFirst');

  const content = [
    `# ${what}`,
    '',
    cost !== null ? `**Estimated cost:** $${cost.toFixed(2)}` : '',
    where ? `**Where:** ${where}` : '',
    '',
    '## Why it came up',
    '',
    ctx.item.why,
    '',
    checkFirst.length > 0 ? '## Check before you buy\n' : '',
    ...checkFirst.map((check) => `- [ ] ${check}`),
    '',
    '---',
    '',
    '*Nothing has been purchased. This is a decision written down so it stops being an open loop.*',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return writeDocument({
    ctx,
    filename: `${slug(ctx, 'purchase')}.md`,
    content,
    scope: 'commerce:prepare',
    verb: 'wrote up the purchase',
    needsInput: 'Decide and buy it yourself when you are ready.',
    summary: (path) =>
      `Wrote up “${what}”${cost !== null ? ` at about $${cost.toFixed(2)}` : ''}` +
      `${checkFirst.length > 0 ? ` with ${checkFirst.length} thing${checkFirst.length === 1 ? '' : 's'} to check first` : ''}. Saved to \`${path}\` — nothing was bought.`,
  });
};

// ─── build_habit ─────────────────────────────────────────────────────────────

/**
 * A habit is the one life item that gets real machinery: the document alone
 * changes nothing, so this also registers the recurring nudge that makes it
 * more than a note.
 */
export const buildHabit = async (ctx: HandlerContext): Promise<HandlerOutcome> => {
  ctx.sandbox.require('artifacts:write');

  const parameters = ctx.item.parameters;
  const habit = str(parameters, 'habit') ?? ctx.item.title;
  const cadence = str(parameters, 'cadence') ?? 'daily';
  const trigger = str(parameters, 'trigger');
  const success = str(parameters, 'successLooksLike');
  const cron = str(parameters, 'cron');

  const content = [
    `# ${habit}`,
    '',
    `**Cadence:** ${cadence}`,
    trigger ? `**Trigger:** ${trigger}` : '',
    '',
    '## Why',
    '',
    ctx.item.why,
    '',
    success ? `## What success looks like\n\n${success}\n` : '',
    '## Tracking',
    '',
    'Mark each one off as you go. A run of blanks is information, not failure —',
    'it usually means the trigger is wrong rather than the habit.',
    '',
    '| Date | Done | Note |',
    '| --- | --- | --- |',
    '|  |  |  |',
  ]
    .filter((line) => line !== '')
    .join('\n');

  if (ctx.dryRun) {
    ctx.record('would set up habit', habit, 'artifacts:write', true);
    return {
      status: 'dry_run',
      summary: `Would set up “${habit}” (${cadence})${cron ? ' with a recurring reminder' : ''}.`,
      actions: ['Preview: set up habit'],
      artifacts: [],
      reversible: true,
    };
  }

  const artifactPath = await writeItemArtifact(ctx.user.userId, ctx.folderName, `${slug(ctx, 'habit')}.md`, content);
  ctx.record('set up habit', habit, 'artifacts:write', true);

  const undo: { kind: string; target: string }[] = [{ kind: 'delete_file', target: artifactPath }];
  let reminderNote = '';

  // The reminder only gets registered when the item type actually carries the
  // scheduling scope, so a habit item can never quietly acquire scheduler reach.
  if (cron && ctx.sandbox.has('schedule:write')) {
    const task = createScheduledTask({
      userId: ctx.user.userId,
      itemId: ctx.item.itemId,
      name: habit,
      cron,
      timezone: 'UTC',
      action: { kind: 'habit_reminder', habit, artifactPath },
      nextRunAt: nextRunFor(cron),
    });
    undo.push({ kind: 'delete_schedule', target: task.taskId });
    ctx.record('registered reminder', `${habit} · ${cron}`, 'schedule:write', true);
    reminderNote = ' A recurring reminder is registered.';
  }

  return {
    status: 'done',
    summary: `Set up “${habit}” — ${cadence}${trigger ? `, triggered by ${trigger}` : ''}.${reminderNote} Tracker saved to \`${artifactPath}\`.`,
    actions: ['Wrote the habit plan', ...(reminderNote ? ['Registered the recurring reminder'] : [])],
    artifacts: [artifactPath],
    reversible: true,
    undo,
  };
};

// ─── learn_topic ─────────────────────────────────────────────────────────────

export const learnTopic = async (ctx: HandlerContext): Promise<HandlerOutcome> => {
  ctx.sandbox.require('artifacts:write');

  const parameters = ctx.item.parameters;
  const topic = str(parameters, 'topic') ?? ctx.item.title;
  const sequence = strArray(parameters, 'sequence');
  const checkpoints = strArray(parameters, 'checkpoints');
  const hours = num(parameters, 'estimatedHours');

  const content = [
    `# Learning: ${topic}`,
    '',
    hours !== null ? `**Estimated:** ~${hours} hour${hours === 1 ? '' : 's'}` : '',
    '',
    '## Why',
    '',
    ctx.item.why,
    '',
    '## Route through it',
    '',
    ...(sequence.length > 0
      ? sequence.map((step, index) => `${index + 1}. ${step}`)
      : ['1. ' + ctx.item.proposedMethod]),
    '',
    checkpoints.length > 0 ? '## You know it when\n' : '',
    ...checkpoints.map((checkpoint) => `- [ ] ${checkpoint}`),
  ]
    .filter((line) => line !== '')
    .join('\n');

  return writeDocument({
    ctx,
    filename: `${slug(ctx, 'learning')}.md`,
    content,
    scope: 'artifacts:write',
    verb: 'laid out the study plan',
    summary: (path) =>
      `Study plan for “${topic}”${sequence.length > 0 ? ` — ${sequence.length} step${sequence.length === 1 ? '' : 's'}` : ''}` +
      `${hours !== null ? `, about ${hours}h` : ''}. Saved to \`${path}\`.`,
  });
};

// ─── contact_person ──────────────────────────────────────────────────────────

/**
 * Produces a draft. The app has no send path and no scope that would permit
 * one — speaking to another person in someone's name is not something an
 * automated approval should ever authorize.
 */
export const contactPerson = async (ctx: HandlerContext): Promise<HandlerOutcome> => {
  ctx.sandbox.require('outbox:draft');
  ctx.sandbox.require('artifacts:write');

  const parameters = ctx.item.parameters;
  const who = str(parameters, 'who') ?? 'them';
  const channel = str(parameters, 'channel') ?? 'email';
  const goal = str(parameters, 'goal');
  const draft = str(parameters, 'draft') ?? ctx.item.proposedMethod;

  const content = [
    `# Draft: ${who}`,
    '',
    `**Channel:** ${channel}`,
    goal ? `**Goal:** ${goal}` : '',
    '',
    '## Draft',
    '',
    draft,
    '',
    '---',
    '',
    '*This has not been sent. Read it, make it sound like you, then send it yourself.*',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return writeDocument({
    ctx,
    filename: `${slug(ctx, 'outreach')}.md`,
    content,
    scope: 'outbox:draft',
    verb: 'drafted the message',
    status: 'done',
    needsInput: 'Review the draft and send it yourself.',
    summary: (path) => `Drafted a ${channel} message to ${who}. Saved to \`${path}\` — nothing was sent.`,
  });
};

// ─── research_topic ──────────────────────────────────────────────────────────

export const researchTopic = async (ctx: HandlerContext): Promise<HandlerOutcome> => {
  ctx.sandbox.require('artifacts:write');

  const parameters = ctx.item.parameters;
  const question = str(parameters, 'question') ?? ctx.item.title;
  const sources = strArray(parameters, 'sources');
  const decides = str(parameters, 'decidesWhat');

  const content = [
    `# ${question}`,
    '',
    decides ? `**This decides:** ${decides}` : '',
    '',
    '## Why it matters',
    '',
    ctx.item.why,
    '',
    sources.length > 0 ? '## Where to look\n' : '',
    ...sources.map((source) => `- ${source}`),
    '',
    '## What I found',
    '',
    '_(fill this in)_',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return writeDocument({
    ctx,
    filename: `${slug(ctx, 'research')}.md`,
    content,
    scope: 'artifacts:write',
    verb: 'framed the question',
    summary: (path) =>
      `Framed “${question}”${sources.length > 0 ? ` with ${sources.length} place${sources.length === 1 ? '' : 's'} to look` : ''}. Saved to \`${path}\`.`,
  });
};

// ─── financial_review ────────────────────────────────────────────────────────

export const financialReview = async (ctx: HandlerContext): Promise<HandlerOutcome> => {
  ctx.sandbox.require('artifacts:write');

  const parameters = ctx.item.parameters;
  const whatToCheck = str(parameters, 'whatToCheck') ?? ctx.item.title;
  const questions = strArray(parameters, 'questions');
  const saving = num(parameters, 'potentialSavingUsd');

  const content = [
    `# ${whatToCheck}`,
    '',
    saving !== null ? `**Potentially worth:** ~$${saving.toFixed(2)}` : '',
    '',
    '## Why it came up',
    '',
    ctx.item.why,
    '',
    questions.length > 0 ? '## Questions to answer\n' : '',
    ...questions.map((question) => `- [ ] ${question}`),
    '',
    '---',
    '',
    '*No account was accessed and nothing was changed. This is a checklist for you or your*',
    '*adviser — general information, not financial advice.*',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return writeDocument({
    ctx,
    filename: `${slug(ctx, 'money-review')}.md`,
    content,
    scope: 'artifacts:write',
    verb: 'wrote the review checklist',
    status: 'done',
    needsInput: 'Work through the checklist against your own accounts.',
    summary: (path) =>
      `Checklist for “${whatToCheck}”${saving !== null ? `, potentially worth about $${saving.toFixed(2)}` : ''}. Saved to \`${path}\` — no account was touched.`,
  });
};
