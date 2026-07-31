import fs from 'node:fs/promises';
import path from 'node:path';
import type { PermissionScope } from '@aiapp/shared';
import { jobFolder, sanitizeFilename, writeItemArtifact } from '../artifacts/fileManager.js';
import type { LlmTool } from '../providers/llm.js';
import type { HandlerContext } from './handlers.js';

/**
 * Toolsets for agentic implementation (spec §4.6).
 *
 * The deterministic handlers each perform one fixed write. These give the model
 * a small set of verbs instead, so it can look before it writes — check whether
 * a skill already exists, read it, and update rather than clobber. That is the
 * difference between "generate a file" and "carry out the instruction".
 *
 * Two invariants hold no matter what the model asks for:
 *
 *   - **Every tool declares the scope it needs and calls `sandbox.require`
 *     first.** An item can only ever reach the permissions its *type* implies,
 *     recomputed server-side, so a model that invents a tool call it wasn't
 *     granted is stopped by the same gate that guards the handlers.
 *   - **Every path is resolved under the user's artifact root.** A `name` the
 *     model chose is sanitised before it touches the filesystem.
 */

/** What a scoped tool reports back, beyond the text the model reads. */
export interface ScopedToolOutcome {
  content: string;
  isError?: boolean;
  /** Paths written, surfaced in the run log and the Files section. */
  artifacts?: string[];
  /** How to reverse this call, so an agentic run stays undoable (BR-I6). */
  undo?: { kind: 'delete_file' | 'remove_line' | 'remove_section' | 'delete_schedule'; target: string }[];
}

/** A tool plus the scope it consumes, so the engine can gate before running. */
export interface ScopedTool extends LlmTool {
  scopes: PermissionScope[];
  run(input: Record<string, unknown>): Promise<ScopedToolOutcome>;
}

const SKILLS_DIR = '_skills';

/** The per-user root that holds `_skills/`, `_instructions.md` and job folders. */
function userRoot(ctx: HandlerContext): string {
  return path.dirname(jobFolder(ctx.user.userId, ctx.folderName));
}

function skillPath(ctx: HandlerContext, name: string): string {
  return path.join(userRoot(ctx), SKILLS_DIR, `${sanitizeFilename(name).replace(/\.md$/, '')}.md`);
}

/**
 * Tools for a `create_skill` item.
 *
 * `list_skills` and `read_skill` are deliberately included: the most common way
 * an automated setup goes wrong is silently overwriting something the user
 * already relies on, and the model can only avoid that if it can look.
 */
export function createSkillTools(ctx: HandlerContext): ScopedTool[] {
  return [
    {
      name: 'list_skills',
      description:
        'List the skills already installed for this user. Call this first, before writing anything, ' +
        'so you can tell whether this post is asking for something that already exists.',
      scopes: ['skills:write'],
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      async run() {
        const dir = path.join(userRoot(ctx), SKILLS_DIR);
        const entries = await fs.readdir(dir).catch(() => [] as string[]);
        const names = entries.filter((entry) => entry.endsWith('.md')).map((entry) => entry.replace(/\.md$/, ''));
        return { content: names.length ? names.join('\n') : '(no skills installed yet)' };
      },
    },
    {
      name: 'read_skill',
      description:
        'Read an existing skill by name. Call this when list_skills shows something related, so you can ' +
        'extend or correct it rather than creating a near-duplicate.',
      scopes: ['skills:write'],
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Skill name, without the .md extension.' } },
        required: ['name'],
        additionalProperties: false,
      },
      async run(input) {
        const name = String(input['name'] ?? '');
        if (!name) return { content: 'A skill name is required.', isError: true };
        const body = await fs.readFile(skillPath(ctx, name), 'utf8').catch(() => null);
        return body === null
          ? { content: `No skill named "${name}" exists yet.`, isError: true }
          : { content: body };
      },
    },
    {
      name: 'write_skill',
      description:
        'Create or replace a reusable skill. The body must be complete enough to use as-is — full markdown ' +
        'with a short "What this does" section and numbered steps. Ground it in what the post actually said; ' +
        'do not invent capabilities the source did not describe.',
      scopes: ['skills:write', 'artifacts:write'],
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'kebab-case skill name, without the .md extension.' },
          description: { type: 'string', description: 'One line describing when to invoke this skill.' },
          body: { type: 'string', description: 'Full markdown body of the skill.' },
        },
        required: ['name', 'description', 'body'],
        additionalProperties: false,
      },
      async run(input) {
        const rawName = String(input['name'] ?? '').trim();
        const description = String(input['description'] ?? '').trim();
        const body = String(input['body'] ?? '').trim();
        if (!rawName || !body) return { content: 'Both name and body are required.', isError: true };

        const name = sanitizeFilename(rawName).replace(/\.md$/, '');
        const content = [
          '---',
          `name: ${name}`,
          `description: ${description.replace(/\n/g, ' ')}`,
          `source: ${ctx.job.url}`,
          `created: ${new Date().toISOString()}`,
          '---',
          '',
          body,
        ].join('\n');

        if (ctx.dryRun) {
          ctx.record('would create skill', `${name}.md (${content.length} bytes)`, 'skills:write', true);
          return { content: `Preview only — would write ${name}.md (${content.length} bytes). Nothing changed.` };
        }

        // Written twice on purpose: into this link's folder as the record of
        // what the run produced, and into _skills/ where it is actually usable.
        const artifactPath = await writeItemArtifact(ctx.user.userId, ctx.folderName, `${name}.md`, content);
        const target = skillPath(ctx, name);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf8');

        ctx.record('created skill', `${SKILLS_DIR}/${name}.md`, 'skills:write', true);
        return {
          content: `Wrote ${SKILLS_DIR}/${name}.md (${content.length} bytes) and filed a copy at ${artifactPath}.`,
          artifacts: [artifactPath, `${SKILLS_DIR}/${name}.md`],
          undo: [{ kind: 'delete_file', target }],
        };
      },
    },
  ];
}

/** The toolsets available per item type. Types absent here use the deterministic handler. */
export const AGENTIC_TOOLSETS: Partial<Record<HandlerContext['item']['type'], (ctx: HandlerContext) => ScopedTool[]>> = {
  create_skill: createSkillTools,
};
