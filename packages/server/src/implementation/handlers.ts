import fs from 'node:fs/promises';
import path from 'node:path';
import type { ItemResult, ItemResultStatus, Job, SpecItem, User } from '@aiapp/shared';
import { ARTIFACT_DIRS } from '@aiapp/shared';
import { config } from '../config.js';
import { jobFolder, writeItemArtifact, sanitizeFilename } from '../artifacts/fileManager.js';
import { getConnector } from '../repo/connectors.js';
import { createScheduledTask, deleteScheduledTasksForItem } from '../repo/schedules.js';
import { llm } from '../providers/llm.js';
import { createLogger, errorMessage } from '../util/logger.js';
import { isAllowedDownloadUrl, isForbiddenCommand, type ItemSandbox } from './guardrails.js';
import { nextRunFor } from './cron.js';

const log = createLogger('impl');

export interface HandlerContext {
  user: User;
  job: Job;
  item: SpecItem;
  folderName: string;
  sandbox: ItemSandbox;
  dryRun: boolean;
  /** Records one action into the run log and the audit trail. */
  record(action: string, detail: string, scope: string | null, ok: boolean): void;
}

export interface HandlerOutcome {
  status: ItemResultStatus;
  summary: string;
  actions: string[];
  artifacts: string[];
  reversible: boolean;
  undo?: ItemResult['undo'];
  needsInput?: string | null;
}

type Handler = (ctx: HandlerContext) => Promise<HandlerOutcome>;

/** Files the engine maintains inside a user's artifact root. */
const SKILLS_DIR = '_skills';
const INSTRUCTIONS_FILE = '_instructions.md';
const SETTINGS_FILE = '_settings.md';

function str(parameters: Record<string, unknown>, key: string): string | null {
  const value = parameters[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function strArray(parameters: Record<string, unknown>, key: string): string[] {
  const value = parameters[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Asks Claude to author real content for an item when the analyzer left the
 * parameters thin. Returns null offline, in which case the handler falls back
 * to the grounded text it already has — never to invented advice.
 */
async function authorContent(item: SpecItem, instruction: string): Promise<string | null> {
  const provider = llm();
  if (!provider.live) return null;
  try {
    const response = await provider.complete({
      system:
        'You write concise, immediately usable artifacts for a personal AI setup. ' +
        'Output only the file content — no preamble, no code fences, no commentary. ' +
        'Ground everything in the item description you are given; do not invent capabilities or claims.',
      prompt: `Item: ${item.title}\nWhy it matters: ${item.why}\nMethod: ${item.proposedMethod}\n\n${instruction}`,
      maxTokens: 2048,
    });
    return response.value.trim() || null;
  } catch (err) {
    log.warn('content authoring failed', { itemId: item.itemId, error: errorMessage(err) });
    return null;
  }
}

// ─── create_skill ────────────────────────────────────────────────────────────

const createSkill: Handler = async (ctx) => {
  ctx.sandbox.require('skills:write');
  ctx.sandbox.require('artifacts:write');

  const name = sanitizeFilename(
    str(ctx.item.parameters, 'name') ??
      ctx.item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
  ).replace(/\.md$/, '');
  const description = str(ctx.item.parameters, 'description') ?? ctx.item.title;

  let body = str(ctx.item.parameters, 'body');
  if (!body || body.length < 120) {
    body =
      (await authorContent(
        ctx.item,
        'Write the full markdown body of a reusable skill that carries out this item. ' +
          'Include a short "What this does" section, numbered steps, and a note on when to use it.',
      )) ?? body;
  }

  const content = [
    '---',
    `name: ${name}`,
    `description: ${description.replace(/\n/g, ' ')}`,
    `source: ${ctx.job.url}`,
    `created: ${new Date().toISOString()}`,
    '---',
    '',
    body ?? `# ${ctx.item.title}\n\n${ctx.item.why}\n\n${ctx.item.proposedMethod}`,
  ].join('\n');

  if (ctx.dryRun) {
    ctx.record('would create skill', `${name}.md (${content.length} bytes)`, 'skills:write', true);
    return {
      status: 'dry_run',
      summary: `Would create the skill “${name}” (${content.length} bytes) in your skills folder.`,
      actions: [`Preview: create skill '${name}'`],
      artifacts: [],
      reversible: true,
    };
  }

  // Written twice on purpose: into this link's folder as a record of what the
  // run produced, and into the shared _skills/ folder where it is actually usable.
  const artifactPath = await writeItemArtifact(ctx.user.userId, ctx.folderName, `${name}.md`, content);

  const skillsRoot = path.join(path.dirname(jobFolder(ctx.user.userId, ctx.folderName)), SKILLS_DIR);
  await fs.mkdir(skillsRoot, { recursive: true });
  const skillPath = path.join(skillsRoot, `${name}.md`);
  await fs.writeFile(skillPath, content, 'utf8');

  ctx.record('created skill', `${SKILLS_DIR}/${name}.md`, 'skills:write', true);
  return {
    status: 'done',
    summary: `Created the reusable skill “${name}”. Drop \`_skills/${name}.md\` into Claude Code (or your assistant’s skills folder) to use it.`,
    actions: [`Created skill '${name}'`, `Filed a copy at ${artifactPath}`],
    artifacts: [artifactPath, `${SKILLS_DIR}/${name}.md`],
    reversible: true,
    undo: [{ kind: 'delete_file', target: skillPath }],
  };
};

// ─── set_instruction ─────────────────────────────────────────────────────────

const setInstruction: Handler = async (ctx) => {
  ctx.sandbox.require('instructions:write');
  ctx.sandbox.require('artifacts:write');

  const instruction = str(ctx.item.parameters, 'instruction') ?? ctx.item.title;
  const line = `- ${instruction.replace(/\n/g, ' ')}  <!-- ${ctx.item.itemId} · ${ctx.job.url} -->`;

  if (ctx.dryRun) {
    ctx.record('would add instruction', instruction.slice(0, 120), 'instructions:write', true);
    return {
      status: 'dry_run',
      summary: `Would add this standing instruction: “${instruction}”`,
      actions: ['Preview: append standing instruction'],
      artifacts: [],
      reversible: true,
    };
  }

  const instructionsPath = path.join(
    path.dirname(jobFolder(ctx.user.userId, ctx.folderName)),
    INSTRUCTIONS_FILE,
  );
  let existing = await fs.readFile(instructionsPath, 'utf8').catch(() => '');
  if (!existing) {
    existing = [
      '# Standing instructions',
      '',
      'Instructions accumulated from the posts you have captured. Paste these into your assistant’s',
      'custom-instructions field, or point Claude Code at this file.',
      '',
    ].join('\n');
  }
  // Idempotent: re-running an item must not duplicate the line.
  if (!existing.includes(ctx.item.itemId)) existing = `${existing.trimEnd()}\n${line}\n`;
  await fs.writeFile(instructionsPath, existing, 'utf8');

  const artifactPath = await writeItemArtifact(
    ctx.user.userId,
    ctx.folderName,
    'instruction.md',
    `${instruction}\n`,
  );

  ctx.record('added standing instruction', instruction.slice(0, 200), 'instructions:write', true);
  return {
    status: 'done',
    summary: `Added the standing instruction “${truncate(instruction, 90)}” to \`${INSTRUCTIONS_FILE}\`.`,
    actions: [`Appended instruction to ${INSTRUCTIONS_FILE}`],
    artifacts: [artifactPath, INSTRUCTIONS_FILE],
    reversible: true,
    undo: [{ kind: 'remove_line', target: `${instructionsPath}::${ctx.item.itemId}` }],
  };
};

// ─── schedule_task ───────────────────────────────────────────────────────────

const scheduleTask: Handler = async (ctx) => {
  ctx.sandbox.require('schedule:write');

  const name = str(ctx.item.parameters, 'name') ?? ctx.item.title;
  const cron = str(ctx.item.parameters, 'cron') ?? '0 7 * * *';
  const timezone = str(ctx.item.parameters, 'timezone') ?? 'UTC';
  const description = str(ctx.item.parameters, 'description') ?? ctx.item.why;

  if (ctx.dryRun) {
    ctx.record('would schedule task', `${name} (${cron})`, 'schedule:write', true);
    return {
      status: 'dry_run',
      summary: `Would schedule “${name}” to run on \`${cron}\` (${timezone}).`,
      actions: ['Preview: register scheduled task'],
      artifacts: [],
      reversible: true,
    };
  }

  // Re-running replaces rather than stacks duplicate schedules.
  deleteScheduledTasksForItem(ctx.item.itemId);
  const task = createScheduledTask({
    userId: ctx.user.userId,
    itemId: ctx.item.itemId,
    name,
    cron,
    timezone,
    action: { kind: 'reminder', description, sourceUrl: ctx.job.url },
    nextRunAt: nextRunFor(cron),
  });

  const artifactPath = await writeItemArtifact(
    ctx.user.userId,
    ctx.folderName,
    'schedule.json',
    `${JSON.stringify({ taskId: task.taskId, name, cron, timezone, description }, null, 2)}\n`,
  );

  ctx.record('registered scheduled task', `${name} · ${cron}`, 'schedule:write', true);
  return {
    status: 'done',
    summary: `Scheduled “${name}” on \`${cron}\` (${timezone}). Next run: ${task.nextRunAt ?? 'pending'}.`,
    actions: [`Registered scheduled task '${name}' (${cron})`],
    artifacts: [artifactPath],
    reversible: true,
    undo: [{ kind: 'delete_schedule', target: task.taskId }],
  };
};

// ─── connect_tool ────────────────────────────────────────────────────────────

/**
 * Connecting a third-party tool needs the user's own sign-in, so this resolves
 * to `needs_input` rather than pretending to have done it (BR-I7, use case 9.5).
 */
const connectTool: Handler = async (ctx) => {
  ctx.sandbox.require('connectors:read');

  const kind = str(ctx.item.parameters, 'kind') ?? ctx.item.prerequisites[0] ?? 'connector';
  const steps = strArray(ctx.item.parameters, 'steps');
  const existing = getConnector(ctx.user.userId, kind);

  if (existing?.configured) {
    ctx.record('verified connector', kind, 'connectors:read', true);
    return {
      status: 'done',
      summary: `The “${kind}” connector is already configured, so this item needed no change.`,
      actions: [`Verified connector '${kind}' is present`],
      artifacts: [],
      reversible: false,
    };
  }

  const guide = [
    `# Connect ${kind}`,
    '',
    `This item needs the **${kind}** connector before it can do anything.`,
    '',
    '## Steps',
    '',
    ...(steps.length > 0
      ? steps.map((step, index) => `${index + 1}. ${step}`)
      : [
          '1. Open Settings → Connectors in the AI Enhancement App.',
          `2. Add the **${kind}** connector and complete its sign-in.`,
          '3. Return to this spec and re-run this item.',
        ]),
    '',
    `Source: ${ctx.job.url}`,
  ].join('\n');

  const artifactPath = ctx.dryRun
    ? ''
    : await writeItemArtifact(ctx.user.userId, ctx.folderName, `connect-${sanitizeFilename(kind)}.md`, guide);

  ctx.record('connector required', kind, 'connectors:read', true);
  return {
    status: ctx.dryRun ? 'dry_run' : 'needs_input',
    summary: `This needs the “${kind}” connector, which isn’t set up yet. Setup steps are saved for you.`,
    actions: [`Recorded that connector '${kind}' is required`],
    artifacts: artifactPath ? [artifactPath] : [],
    reversible: false,
    needsInput: `Connect ${kind} in Settings → Connectors, then re-run this item.`,
  };
};

// ─── generate_file ───────────────────────────────────────────────────────────

const generateFile: Handler = async (ctx) => {
  ctx.sandbox.require('artifacts:write');

  const filename = sanitizeFilename(str(ctx.item.parameters, 'filename') ?? `${ctx.item.title}.md`);
  let content = str(ctx.item.parameters, 'content');
  if (!content || content.length < 80) {
    content =
      (await authorContent(ctx.item, `Write the full contents of the file "${filename}" that this item describes.`)) ??
      content ??
      `# ${ctx.item.title}\n\n${ctx.item.why}\n\n${ctx.item.proposedMethod}\n`;
  }

  if (ctx.dryRun) {
    ctx.record('would generate file', `${filename} (${content.length} bytes)`, 'artifacts:write', true);
    return {
      status: 'dry_run',
      summary: `Would generate \`${filename}\` (${content.length} bytes).`,
      actions: [`Preview: generate ${filename}`],
      artifacts: [],
      reversible: true,
    };
  }

  const artifactPath = await writeItemArtifact(ctx.user.userId, ctx.folderName, filename, content);
  ctx.record('generated file', artifactPath, 'artifacts:write', true);
  return {
    status: 'done',
    summary: `Generated \`${filename}\` in this link’s artifacts folder.`,
    actions: [`Generated ${filename}`],
    artifacts: [artifactPath],
    reversible: true,
    undo: [
      {
        kind: 'delete_file',
        target: path.join(jobFolder(ctx.user.userId, ctx.folderName), ARTIFACT_DIRS.artifacts, filename),
      },
    ],
  };
};

// ─── download_file ───────────────────────────────────────────────────────────

const downloadFile: Handler = async (ctx) => {
  ctx.sandbox.require('net:read');
  ctx.sandbox.require('artifacts:write');

  const url = str(ctx.item.parameters, 'url');
  const filename = sanitizeFilename(str(ctx.item.parameters, 'filename') ?? 'download.bin');

  if (!url) {
    ctx.record('download skipped', 'no direct URL in the post', 'net:read', false);
    return {
      status: 'needs_input',
      summary: 'The post points at a resource but gives no direct link, so there was nothing to fetch.',
      actions: ['No downloadable URL was found in the source'],
      artifacts: [],
      reversible: false,
      needsInput: 'Paste the download link for this resource and re-run the item.',
    };
  }

  const allowed = isAllowedDownloadUrl(url);
  if (!allowed.ok) {
    ctx.record('download blocked', `${url} — ${allowed.reason}`, 'net:read', false);
    return {
      status: 'not_possible',
      summary: `Refused to download from that address (${allowed.reason}).`,
      actions: [`Blocked download from ${url}`],
      artifacts: [],
      reversible: false,
    };
  }

  if (ctx.dryRun) {
    ctx.record('would download', url, 'net:read', true);
    return {
      status: 'dry_run',
      summary: `Would download \`${filename}\` from ${url}.`,
      actions: [`Preview: download ${url}`],
      artifacts: [],
      reversible: true,
    };
  }

  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    // Cap the write so a huge or hostile response cannot fill the disk.
    const MAX_BYTES = 25 * 1024 * 1024;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) throw new Error(`file exceeds the ${MAX_BYTES / 1024 / 1024}MB limit`);

    const artifactPath = await writeItemArtifact(ctx.user.userId, ctx.folderName, filename, buffer);
    ctx.record('downloaded file', `${url} → ${artifactPath}`, 'net:read', true);
    return {
      status: 'done',
      summary: `Downloaded \`${filename}\` (${(buffer.byteLength / 1024).toFixed(0)} KB) into this link’s artifacts folder.`,
      actions: [`Downloaded ${url}`],
      artifacts: [artifactPath],
      reversible: true,
      undo: [
        {
          kind: 'delete_file',
          target: path.join(jobFolder(ctx.user.userId, ctx.folderName), ARTIFACT_DIRS.artifacts, filename),
        },
      ],
    };
  } catch (err) {
    const message = errorMessage(err);
    ctx.record('download failed', message, 'net:read', false);
    return {
      status: 'not_possible',
      summary: `The download could not be completed: ${message}.`,
      actions: [`Download from ${url} failed: ${message}`],
      artifacts: [],
      reversible: false,
    };
  }
};

// ─── configure_setting ───────────────────────────────────────────────────────

const configureSetting: Handler = async (ctx) => {
  ctx.sandbox.require('instructions:write');
  ctx.sandbox.require('artifacts:write');

  const setting = str(ctx.item.parameters, 'setting') ?? ctx.item.title;
  const value = str(ctx.item.parameters, 'value') ?? 'see steps';
  const steps = strArray(ctx.item.parameters, 'steps');

  const entry = [
    `## ${setting}`,
    '',
    `**Target value:** ${value}`,
    '',
    ...(steps.length ? steps.map((step, index) => `${index + 1}. ${step}`) : [ctx.item.proposedMethod]),
    '',
    `*From ${ctx.job.url} · item ${ctx.item.itemId}*`,
    '',
  ].join('\n');

  if (ctx.dryRun) {
    ctx.record('would record setting', setting, 'instructions:write', true);
    return {
      status: 'dry_run',
      summary: `Would record the setting change “${setting}” → ${value}.`,
      actions: ['Preview: record setting change'],
      artifacts: [],
      reversible: true,
    };
  }

  const settingsPath = path.join(path.dirname(jobFolder(ctx.user.userId, ctx.folderName)), SETTINGS_FILE);
  let existing = await fs.readFile(settingsPath, 'utf8').catch(() => '');
  if (!existing) existing = '# Setting changes\n\nChanges recommended by the posts you have captured.\n\n';
  if (!existing.includes(ctx.item.itemId)) existing = `${existing.trimEnd()}\n\n${entry}`;
  await fs.writeFile(settingsPath, existing, 'utf8');

  const artifactPath = await writeItemArtifact(ctx.user.userId, ctx.folderName, 'setting.md', entry);
  ctx.record('recorded setting change', `${setting} = ${value}`, 'instructions:write', true);
  return {
    status: 'done',
    summary: `Recorded the setting change “${setting}” → ${value} in \`${SETTINGS_FILE}\`, with the exact steps.`,
    actions: [`Recorded setting '${setting}'`],
    artifacts: [artifactPath, SETTINGS_FILE],
    reversible: true,
    undo: [{ kind: 'remove_section', target: `${settingsPath}::${ctx.item.itemId}` }],
  };
};

// ─── run_command ─────────────────────────────────────────────────────────────

/**
 * Commands are prepared and explained, never executed. This is the "bounded
 * blast radius" line in spec §9: the engine's job is to make the step trivial
 * for the user to run, not to run arbitrary shell on their behalf.
 */
const runCommand: Handler = async (ctx) => {
  ctx.sandbox.require('artifacts:write');

  const command = str(ctx.item.parameters, 'command') ?? '';
  const explanation = str(ctx.item.parameters, 'explanation') ?? ctx.item.why;

  if (!command) {
    return {
      status: 'needs_input',
      summary: 'No command could be identified from the post, so nothing was prepared.',
      actions: [],
      artifacts: [],
      reversible: false,
      needsInput: 'Provide the exact command this tip refers to.',
    };
  }

  if (isForbiddenCommand(command)) {
    ctx.record('command refused', truncate(command, 200), 'shell:exec', false);
    return {
      status: 'not_possible',
      summary: 'That command is destructive or privilege-escalating, so it was not prepared.',
      actions: ['Refused to prepare an unsafe command'],
      artifacts: [],
      reversible: false,
    };
  }

  const content = [
    `# ${ctx.item.title}`,
    '',
    '## Command',
    '',
    '```bash',
    command,
    '```',
    '',
    '## What it does',
    '',
    explanation,
    '',
    '> Prepared, not executed. Review it and run it yourself when you are ready.',
    '',
    `Source: ${ctx.job.url}`,
  ].join('\n');

  if (ctx.dryRun) {
    return {
      status: 'dry_run',
      summary: `Would prepare the command \`${truncate(command, 60)}\` for you to run.`,
      actions: ['Preview: prepare command'],
      artifacts: [],
      reversible: true,
    };
  }

  const artifactPath = await writeItemArtifact(ctx.user.userId, ctx.folderName, 'command.md', content);
  ctx.record('prepared command', truncate(command, 200), 'shell:exec', true);
  return {
    status: 'partial',
    summary: `Prepared the command with an explanation — run it yourself when ready. Saved to \`${artifactPath}\`.`,
    actions: ['Prepared command for manual execution'],
    artifacts: [artifactPath],
    reversible: true,
    needsInput: 'Review and run the prepared command yourself.',
  };
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export const HANDLERS: Record<SpecItem['type'], Handler> = {
  create_skill: createSkill,
  set_instruction: setInstruction,
  schedule_task: scheduleTask,
  connect_tool: connectTool,
  generate_file: generateFile,
  download_file: downloadFile,
  configure_setting: configureSetting,
  run_command: runCommand,
};

/** Replays an item's recorded undo steps (BR-I6). */
export async function undoItem(undo: NonNullable<ItemResult['undo']>): Promise<string[]> {
  const done: string[] = [];
  for (const step of undo) {
    try {
      if (step.kind === 'delete_file') {
        // Only ever inside the configured artifact root.
        const resolved = path.resolve(step.target);
        if (!resolved.startsWith(path.resolve(config().artifactRoot) + path.sep)) continue;
        await fs.rm(resolved, { force: true });
        done.push(`Removed ${path.basename(resolved)}`);
      } else if (step.kind === 'remove_line' || step.kind === 'remove_section') {
        const [file, marker] = step.target.split('::');
        if (!file || !marker) continue;
        const resolved = path.resolve(file);
        if (!resolved.startsWith(path.resolve(config().artifactRoot) + path.sep)) continue;
        const content = await fs.readFile(resolved, 'utf8').catch(() => null);
        if (content === null) continue;
        if (step.kind === 'remove_line') {
          const kept = content.split('\n').filter((line) => !line.includes(marker));
          await fs.writeFile(resolved, kept.join('\n'), 'utf8');
        } else {
          // Sections are delimited by `##` headings; drop the one carrying the marker.
          const sections = content.split(/\n(?=## )/);
          const kept = sections.filter((section) => !section.includes(marker));
          await fs.writeFile(resolved, kept.join('\n'), 'utf8');
        }
        done.push(`Reverted the entry in ${path.basename(resolved)}`);
      } else if (step.kind === 'delete_schedule') {
        const { deleteScheduledTask } = await import('../repo/schedules.js');
        if (deleteScheduledTask(step.target)) done.push('Unscheduled the recurring task');
      }
    } catch (err) {
      log.warn('undo step failed', { kind: step.kind, error: errorMessage(err) });
    }
  }
  return done;
}
