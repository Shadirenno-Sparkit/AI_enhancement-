import { createHash } from 'node:crypto';
import { writeItemArtifact, sanitizeFilename } from '../artifacts/fileManager.js';
import { createScheduledTask } from '../repo/schedules.js';
import { nextRunFor } from './cron.js';
import type { HandlerContext, HandlerOutcome } from './handlers.js';

/**
 * Automation export (spec §4.6c).
 *
 * `automation_workflow` items describe multi-step work across tools. Rather than
 * inventing a runner for that, the engine emits a workflow file for n8n — an
 * existing, self-hostable automation platform the user very likely already has
 * or can stand up in minutes.
 *
 * The generated file is a real n8n workflow: importable through
 * *Workflows → Import from File* with no hand-editing needed to open it. The
 * step nodes are NoOp placeholders named for the tool and action they stand in
 * for, because guessing at credentials and API shapes would produce a file that
 * imports and then fails. A scaffold that opens cleanly and shows the intended
 * shape is more useful than a broken attempt at the real thing.
 */

export interface WorkflowStep {
  name: string;
  tool?: string;
  action?: string;
}

interface N8nNode {
  parameters: Record<string, unknown>;
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  notes?: string;
}

interface N8nWorkflow {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, { main: { node: string; type: string; index: number }[][] }>;
  settings: Record<string, unknown>;
  pinData: Record<string, unknown>;
  meta: Record<string, unknown>;
}

/** n8n needs stable per-node ids; derive them so re-export produces the same file. */
function nodeId(workflowName: string, nodeName: string, index: number): string {
  const hash = createHash('sha1').update(`${workflowName}:${nodeName}:${index}`).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

/** Ensures every node name is unique — n8n keys its connection graph by name. */
function uniqueNames(steps: WorkflowStep[]): string[] {
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const base = (step.name || 'Step').slice(0, 60);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base} ${count + 1}`;
  });
}

export function buildN8nWorkflow(input: {
  name: string;
  trigger?: string | null;
  cron?: string | null;
  steps: WorkflowStep[];
  sourceUrl?: string;
}): N8nWorkflow {
  const name = input.name.slice(0, 100) || 'Captured automation';
  const nodes: N8nNode[] = [];
  const connections: N8nWorkflow['connections'] = {};

  // A cron expression makes this a schedule trigger; without one it is manual,
  // so importing the file never starts something running unattended.
  const hasCron = Boolean(input.cron && input.cron.split(/\s+/).length === 5);
  const triggerName = hasCron ? 'Schedule' : 'When you run it';

  nodes.push(
    hasCron
      ? {
          parameters: {
            rule: { interval: [{ field: 'cronExpression', expression: input.cron }] },
          },
          id: nodeId(name, triggerName, 0),
          name: triggerName,
          type: 'n8n-nodes-base.scheduleTrigger',
          typeVersion: 1.2,
          position: [0, 0],
          notes: input.trigger ?? undefined,
        }
      : {
          parameters: {},
          id: nodeId(name, triggerName, 0),
          name: triggerName,
          type: 'n8n-nodes-base.manualTrigger',
          typeVersion: 1,
          position: [0, 0],
          notes: input.trigger ?? undefined,
        },
  );

  const stepNames = uniqueNames(input.steps);
  stepNames.forEach((stepName, index) => {
    const step = input.steps[index]!;
    nodes.push({
      parameters: {},
      id: nodeId(name, stepName, index + 1),
      name: stepName,
      type: 'n8n-nodes-base.noOp',
      typeVersion: 1,
      position: [(index + 1) * 220, 0],
      notes: [step.tool ? `Tool: ${step.tool}` : '', step.action ? `Action: ${step.action}` : '']
        .filter(Boolean)
        .join('\n') || undefined,
    });
  });

  // Chain every node to the next one.
  const chain = [triggerName, ...stepNames];
  for (let index = 0; index < chain.length - 1; index++) {
    connections[chain[index]!] = {
      main: [[{ node: chain[index + 1]!, type: 'main', index: 0 }]],
    };
  }

  return {
    name,
    nodes,
    connections,
    settings: { executionOrder: 'v1' },
    pinData: {},
    meta: { source: input.sourceUrl ?? 'AI Enhancement App' },
  };
}

export const automationWorkflow = async (ctx: HandlerContext): Promise<HandlerOutcome> => {
  ctx.sandbox.require('artifacts:write');

  const parameters = ctx.item.parameters;
  const name =
    (typeof parameters['name'] === 'string' && parameters['name'].trim()) || ctx.item.title;
  const trigger = typeof parameters['trigger'] === 'string' ? parameters['trigger'] : null;
  const cron = typeof parameters['cron'] === 'string' ? parameters['cron'] : null;

  const rawSteps = Array.isArray(parameters['steps']) ? parameters['steps'] : [];
  const steps: WorkflowStep[] = rawSteps
    .map((entry): WorkflowStep | null => {
      if (typeof entry === 'string') return { name: entry };
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        const stepName = typeof record['name'] === 'string' ? record['name'] : null;
        if (!stepName) return null;
        return {
          name: stepName,
          tool: typeof record['tool'] === 'string' ? record['tool'] : undefined,
          action: typeof record['action'] === 'string' ? record['action'] : undefined,
        };
      }
      return null;
    })
    .filter((step): step is WorkflowStep => step !== null)
    .slice(0, 25);

  if (steps.length === 0) {
    return {
      status: 'not_possible',
      summary: 'This automation had no steps described, so there was nothing to build.',
      actions: [],
      artifacts: [],
      reversible: false,
    };
  }

  const workflow = buildN8nWorkflow({ name, trigger, cron, steps, sourceUrl: ctx.job.url });
  const json = JSON.stringify(workflow, null, 2);
  const base = sanitizeFilename(name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/\.md$/, '');

  const readme = [
    `# ${name}`,
    '',
    trigger ? `**Runs when:** ${trigger}` : '',
    cron ? `**Schedule:** \`${cron}\`` : '',
    '',
    '## Why',
    '',
    ctx.item.why,
    '',
    '## Steps',
    '',
    ...steps.map(
      (step, index) =>
        `${index + 1}. **${step.name}**${step.tool ? ` — ${step.tool}` : ''}${step.action ? `: ${step.action}` : ''}`,
    ),
    '',
    '## Import it',
    '',
    `1. Open n8n → **Workflows** → **Import from File**.`,
    `2. Choose \`${base}.n8n.json\`.`,
    `3. Open each step and connect the credential for its tool.`,
    '',
    'The steps import as placeholders naming the tool and action they stand for.',
    'Credentials and API shapes are yours to fill in — guessing at them would produce',
    'a workflow that imports and then fails on its first run.',
  ]
    .filter((line) => line !== '')
    .join('\n');

  if (ctx.dryRun) {
    ctx.record('would build workflow', `${steps.length} steps`, 'artifacts:write', true);
    return {
      status: 'dry_run',
      summary: `Would build an n8n workflow “${name}” with ${steps.length} step${steps.length === 1 ? '' : 's'}.`,
      actions: ['Preview: build automation workflow'],
      artifacts: [],
      reversible: true,
    };
  }

  const workflowPath = await writeItemArtifact(ctx.user.userId, ctx.folderName, `${base}.n8n.json`, json);
  const readmePath = await writeItemArtifact(ctx.user.userId, ctx.folderName, `${base}.md`, readme);
  ctx.record('built workflow', `${name} · ${steps.length} steps`, 'artifacts:write', true);

  const undo = [
    { kind: 'delete_file', target: workflowPath },
    { kind: 'delete_file', target: readmePath },
  ];
  const actions = ['Generated the n8n workflow', 'Wrote the import instructions'];

  // A cron in the parameters means the user asked for this to recur. Register it
  // here too so the app's own scheduler nudges them even before they import it.
  if (cron && ctx.sandbox.has('schedule:write')) {
    const task = createScheduledTask({
      userId: ctx.user.userId,
      itemId: ctx.item.itemId,
      name,
      cron,
      timezone: 'UTC',
      action: { kind: 'automation_reminder', name, workflowPath },
      nextRunAt: nextRunFor(cron),
    });
    undo.push({ kind: 'delete_schedule', target: task.taskId });
    actions.push('Registered the schedule');
  }

  return {
    status: 'done',
    summary:
      `Built “${name}” as an importable n8n workflow with ${steps.length} step${steps.length === 1 ? '' : 's'}. ` +
      `Saved to \`${workflowPath}\` — import it and connect your credentials.`,
    actions,
    artifacts: [workflowPath, readmePath],
    reversible: true,
    undo,
    needsInput: 'Import the workflow into n8n and connect each step’s credential.',
  };
};

// ─── create_project ──────────────────────────────────────────────────────────

/**
 * Builds a whole project folder — instructions plus its own skills — rather than
 * a single loose file. This is the "set up a project in my Claude account"
 * shape: a directory that can be opened as a workspace as-is.
 */
export const createProject = async (ctx: HandlerContext): Promise<HandlerOutcome> => {
  ctx.sandbox.require('artifacts:write');
  ctx.sandbox.require('skills:write');
  ctx.sandbox.require('instructions:write');

  const parameters = ctx.item.parameters;
  const name = (typeof parameters['name'] === 'string' && parameters['name'].trim()) || ctx.item.title;
  const purpose = typeof parameters['purpose'] === 'string' ? parameters['purpose'] : ctx.item.why;
  const instructions =
    typeof parameters['instructions'] === 'string' ? parameters['instructions'] : ctx.item.proposedMethod;

  const rawSkills = Array.isArray(parameters['skills']) ? parameters['skills'] : [];
  const skills = rawSkills
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const skillName = typeof record['name'] === 'string' ? record['name'] : null;
      const body = typeof record['body'] === 'string' ? record['body'] : null;
      return skillName && body ? { name: skillName, body } : null;
    })
    .filter((skill): skill is { name: string; body: string } => skill !== null)
    .slice(0, 10);

  const base = sanitizeFilename(name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/\.md$/, '');

  if (ctx.dryRun) {
    ctx.record('would create project', `${name} (${skills.length} skills)`, 'artifacts:write', true);
    return {
      status: 'dry_run',
      summary: `Would create the project “${name}” with ${skills.length} skill${skills.length === 1 ? '' : 's'}.`,
      actions: ['Preview: create project'],
      artifacts: [],
      reversible: true,
    };
  }

  const artifacts: string[] = [];
  const readme = [
    `# ${name}`,
    '',
    '## Purpose',
    '',
    purpose,
    '',
    '## Instructions',
    '',
    instructions,
    '',
    skills.length > 0 ? `## Skills\n\n${skills.map((skill) => `- \`${skill.name}\``).join('\n')}\n` : '',
    '---',
    '',
    `*Built from ${ctx.job.url}*`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  artifacts.push(
    await writeItemArtifact(ctx.user.userId, ctx.folderName, `${base}/README.md`, readme),
  );
  artifacts.push(
    await writeItemArtifact(ctx.user.userId, ctx.folderName, `${base}/instructions.md`, instructions),
  );

  for (const skill of skills) {
    const skillFile = sanitizeFilename(skill.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/\.md$/, '');
    artifacts.push(
      await writeItemArtifact(
        ctx.user.userId,
        ctx.folderName,
        `${base}/skills/${skillFile}.md`,
        ['---', `name: ${skill.name}`, `project: ${name}`, '---', '', skill.body].join('\n'),
      ),
    );
  }

  ctx.record('created project', `${name} · ${skills.length} skills`, 'artifacts:write', true);

  return {
    status: 'done',
    summary:
      `Created the project “${name}”${skills.length > 0 ? ` with ${skills.length} skill${skills.length === 1 ? '' : 's'}` : ''}. ` +
      `Open the \`${base}/\` folder as a project.`,
    actions: ['Created the project folder', ...(skills.length > 0 ? [`Wrote ${skills.length} skills`] : [])],
    artifacts,
    reversible: true,
    undo: artifacts.map((target) => ({ kind: 'delete_file', target })),
  };
};
