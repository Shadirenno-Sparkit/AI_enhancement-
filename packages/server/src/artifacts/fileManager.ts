import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  Decision,
  ImplementationRun,
  InsightSource,
  Job,
  Spec,
  SpecItem,
} from '@aiapp/shared';
import {
  ARTIFACT_DIRS,
  ARTIFACT_FILES,
  INDEX_FILE,
  PLATFORM_LABELS,
  folderNameFor,
  isSafePathComponent,
} from '@aiapp/shared';
import { config } from '../config.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('artifacts');

/**
 * Root of one user's artifact tree. Everything the file manager writes lives
 * under here, and every path is validated against it before a write so a
 * crafted folder name can never escape (per-user isolation, BR-S2).
 */
export function userRoot(userId: string): string {
  if (!isSafePathComponent(userId)) throw new Error(`Unsafe user id: ${userId}`);
  return path.join(config().artifactRoot, userId);
}

export function jobFolder(userId: string, folderName: string): string {
  if (!isSafePathComponent(folderName)) throw new Error(`Unsafe folder name: ${folderName}`);
  const root = userRoot(userId);
  const target = path.join(root, folderName);
  const resolved = path.resolve(target);
  if (resolved !== path.resolve(root) && !resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('Refusing to write outside the user artifact root');
  }
  return resolved;
}

/** Derives (and reserves) the per-link folder name. BR-F3, spec §11.2. */
export async function ensureJobFolder(job: Job, title: string): Promise<string> {
  const base = folderNameFor(job.createdAt, job.platform, title || job.platform);
  const root = userRoot(job.userId);
  await fs.mkdir(root, { recursive: true });

  // Two links captured the same day from the same platform with similar titles
  // would otherwise collide; suffix until the name is free.
  let candidate = base;
  for (let suffix = 2; suffix < 100; suffix++) {
    const target = path.join(root, candidate);
    try {
      await fs.mkdir(target, { recursive: false });
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      // Reuse the folder if it already belongs to this job.
      const marker = path.join(target, ARTIFACT_FILES.source);
      const owned = await readJson<{ jobId?: string }>(marker);
      if (owned?.jobId === job.jobId) break;
      candidate = `${base}-${suffix}`;
    }
  }

  const folder = jobFolder(job.userId, candidate);
  await fs.mkdir(path.join(folder, ARTIFACT_DIRS.artifacts), { recursive: true });
  await fs.mkdir(path.join(folder, ARTIFACT_DIRS.media), { recursive: true });
  return candidate;
}

/**
 * Renames a job folder once analysis has produced a real title (BR-F3).
 *
 * The folder has to exist before analysis — every earlier stage writes into it —
 * so it is first created from whatever title the fetch produced, often just
 * "Instagram post". Renaming afterwards is what makes the folder list browsable
 * without opening anything. Returns the folder name now in effect, which is the
 * original one if the rename could not be done.
 */
export async function renameJobFolder(
  userId: string,
  currentName: string,
  date: string,
  platform: Job['platform'],
  title: string,
): Promise<string> {
  const desired = folderNameFor(date, platform, title || platform);
  if (desired === currentName) return currentName;

  const root = userRoot(userId);
  const from = jobFolder(userId, currentName);

  let candidate = desired;
  for (let suffix = 2; suffix < 100; suffix++) {
    const to = path.join(root, candidate);
    try {
      // `rename` onto an existing directory fails, which is exactly the check
      // we want — no silent overwrite of another link's folder.
      await fs.rename(from, to);
      return candidate;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') {
        candidate = `${desired}-${suffix}`;
        continue;
      }
      log.warn('could not rename job folder', { from: currentName, to: candidate, error: String(err) });
      return currentName;
    }
  }
  return currentName;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function write(folder: string, name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(folder, name), content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

// ─── Individual artifacts (spec §11.1) ───────────────────────────────────────

export async function writeSource(
  userId: string,
  folderName: string,
  job: Job,
  extra: { title?: string | null; author?: string | null; methods?: string[] },
): Promise<void> {
  const folder = jobFolder(userId, folderName);
  await write(
    folder,
    ARTIFACT_FILES.source,
    JSON.stringify(
      {
        jobId: job.jobId,
        url: job.url,
        normalizedUrl: job.normalizedUrl,
        platform: job.platform,
        platformLabel: PLATFORM_LABELS[job.platform],
        title: extra.title ?? job.title,
        author: extra.author ?? null,
        capturedAt: job.createdAt,
        captureSource: job.captureSource,
        sharedText: job.sharedText ?? null,
        note: job.note ?? null,
        extractionMethods: extra.methods ?? [],
      },
      null,
      2,
    ),
  );
}

export async function writeTranscript(
  userId: string,
  folderName: string,
  content: { vtt: string | null; text: string },
): Promise<void> {
  const folder = jobFolder(userId, folderName);
  if (content.vtt) await write(folder, ARTIFACT_FILES.transcriptVtt, content.vtt);
  await write(folder, ARTIFACT_FILES.transcriptTxt, content.text || '(no transcript text was extracted)');
}

export async function writeInsights(
  userId: string,
  folderName: string,
  source: InsightSource,
): Promise<void> {
  const folder = jobFolder(userId, folderName);
  await write(
    folder,
    ARTIFACT_FILES.insights,
    JSON.stringify(
      {
        insightSourceId: source.insightSourceId,
        jobId: source.jobId,
        language: source.language,
        durationSec: source.durationSec,
        overallConfidence: source.overallConfidence,
        lowConfidence: source.lowConfidence,
        methodsUsed: source.methodsUsed,
        segments: source.segments,
      },
      null,
      2,
    ),
  );
}

export async function writeSummary(
  userId: string,
  folderName: string,
  job: Job,
  spec: Spec,
): Promise<void> {
  const folder = jobFolder(userId, folderName);
  const lines = [
    `# ${spec.title}`,
    '',
    `*${PLATFORM_LABELS[job.platform]} · captured ${job.createdAt.slice(0, 10)}*`,
    '',
    `[Open the original](${job.url})`,
    '',
    '## What this post is telling you to do',
    '',
    spec.summaryPlainEnglish,
    '',
  ];

  if (spec.items.length > 0) {
    lines.push('## Proposed improvements', '');
    spec.items.forEach((item, index) => {
      const flags: string[] = [];
      if (item.missingPrerequisites.length > 0) flags.push(`needs ${item.missingPrerequisites.join(', ')}`);
      if (item.duplicateOfItemId) flags.push('similar to something you already approved');
      lines.push(
        `${index + 1}. **${item.title}** — ${item.why}`,
        `   *${item.effort} effort · ${item.impact} impact · \`${item.type}\`*${flags.length ? ` · ⚠︎ ${flags.join('; ')}` : ''}`,
        '',
      );
    });
  } else {
    lines.push('No actionable items were found in this post.', '');
  }

  await write(folder, ARTIFACT_FILES.summary, lines.join('\n'));
}

export async function writeSpec(userId: string, folderName: string, spec: Spec): Promise<void> {
  await write(jobFolder(userId, folderName), ARTIFACT_FILES.spec, spec.technicalSpec);
}

export async function writePlan(
  userId: string,
  folderName: string,
  spec: Spec,
  decisions: Decision[],
): Promise<void> {
  const folder = jobFolder(userId, folderName);
  const byItem = new Map(decisions.map((d) => [d.itemId, d]));

  const lines = [`# Implementation plan`, '', `Spec: \`${spec.specId}\``, ''];
  if (spec.items.length === 0) {
    lines.push('Nothing to implement — no actionable items were identified.');
  } else {
    lines.push('| # | Item | Type | Decision | Scopes | Prerequisites |', '| --- | --- | --- | --- | --- | --- |');
    spec.items.forEach((item, index) => {
      const decision = byItem.get(item.itemId)?.decision ?? 'pending';
      lines.push(
        `| ${index + 1} | ${escapeCell(item.title)} | \`${item.type}\` | ${decision} | ${item.scopes.join(', ')} | ${
          item.prerequisites.join(', ') || '—'
        } |`,
      );
    });
    lines.push('', '## Method per item', '');
    spec.items.forEach((item, index) => {
      lines.push(`### ${index + 1}. ${item.title}`, '', item.proposedMethod, '');
    });
  }
  await write(folder, ARTIFACT_FILES.plan, lines.join('\n'));
}

export async function writeDecisions(
  userId: string,
  folderName: string,
  spec: Spec,
  decisions: Decision[],
): Promise<void> {
  const folder = jobFolder(userId, folderName);
  const byItem = new Map(decisions.map((d) => [d.itemId, d]));
  await write(
    folder,
    ARTIFACT_FILES.decisions,
    JSON.stringify(
      {
        specId: spec.specId,
        decisions: spec.items.map((item) => ({
          itemId: item.itemId,
          title: item.title,
          type: item.type,
          decision: byItem.get(item.itemId)?.decision ?? 'pending',
          edits: byItem.get(item.itemId)?.edits ?? null,
          decidedAt: byItem.get(item.itemId)?.decidedAt ?? null,
        })),
      },
      null,
      2,
    ),
  );
}

export async function writeRunLog(
  userId: string,
  folderName: string,
  run: ImplementationRun,
  items: SpecItem[],
): Promise<void> {
  const folder = jobFolder(userId, folderName);
  const byId = new Map(items.map((item) => [item.itemId, item]));

  const lines = [
    `# Run log`,
    '',
    `**Run:** \`${run.runId}\``,
    `**Mode:** ${run.dryRun ? 'dry run (preview only — nothing was changed)' : 'live'}`,
    `**Started:** ${run.startedAt}`,
    run.finishedAt ? `**Finished:** ${run.finishedAt}` : '',
    `**Outcome:** ${run.overall ?? run.status}`,
    '',
    '## Results by item',
    '',
  ].filter(Boolean);

  for (const result of run.items) {
    const item = byId.get(result.itemId);
    lines.push(
      `### ${result.title}`,
      '',
      `- **Status:** ${result.status}`,
      `- **Outcome:** ${result.summary}`,
      `- **Type:** \`${result.type}\``,
      `- **Reversible:** ${result.reversible ? 'yes' : 'no'}`,
      item ? `- **Scopes used:** ${item.scopes.join(', ')}` : '',
      result.needsInput ? `- **Needs from you:** ${result.needsInput}` : '',
      '',
    );
    if (result.actions.length > 0) {
      lines.push('Actions taken:', '');
      for (const action of result.actions) lines.push(`- ${action}`);
      lines.push('');
    }
    if (result.artifacts.length > 0) {
      lines.push('Artifacts:', '');
      for (const artifact of result.artifacts) lines.push(`- \`${artifact}\``);
      lines.push('');
    }
  }

  if (run.actions.length > 0) {
    lines.push('## Full action trail', '', '| Time | Item | Action | Scope | OK | Detail |', '| --- | --- | --- | --- | --- | --- |');
    for (const action of run.actions) {
      lines.push(
        `| ${action.at.slice(11, 19)} | ${action.itemId ?? '—'} | ${escapeCell(action.action)} | ${
          action.scope ?? '—'
        } | ${action.ok ? '✓' : '✗'} | ${escapeCell(action.detail)} |`,
      );
    }
  }

  await write(folder, ARTIFACT_FILES.runLog, lines.filter((line) => line !== '').join('\n'));
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Writes a file produced by an implementation item into `artifacts/`. */
export async function writeItemArtifact(
  userId: string,
  folderName: string,
  filename: string,
  content: string | Buffer,
): Promise<string> {
  const folder = jobFolder(userId, folderName);
  const safe = sanitizeFilename(filename);
  const target = path.join(folder, ARTIFACT_DIRS.artifacts, safe);
  const resolved = path.resolve(target);
  const bounds = path.resolve(path.join(folder, ARTIFACT_DIRS.artifacts));
  if (!resolved.startsWith(bounds + path.sep)) throw new Error('Refusing to write outside the artifacts folder');
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content);
  return path.join(ARTIFACT_DIRS.artifacts, safe);
}

export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '');
  return base || 'artifact';
}

// ─── Index (spec §11.2, BR-F4) ───────────────────────────────────────────────

export interface IndexEntry {
  folderName: string;
  date: string;
  platform: string;
  title: string;
  status: string;
  url: string;
  itemSummary: string;
}

/** Rewrites `_index.md` — the browsable list of everything processed. */
export async function writeIndex(userId: string, entries: IndexEntry[]): Promise<void> {
  const root = userRoot(userId);
  await fs.mkdir(root, { recursive: true });

  const lines = [
    '# AI Enhancement App',
    '',
    'Every link you have captured, newest first. Each row links to the folder holding that link’s',
    'transcript, insights, summary, spec, plan, decisions and run log.',
    '',
    `*Last updated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC*`,
    '',
    '| Date | Platform | Title | Status | Items | Folder |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  for (const entry of entries) {
    lines.push(
      `| ${entry.date} | ${entry.platform} | [${escapeCell(entry.title)}](${entry.url}) | ${entry.status} | ${
        entry.itemSummary
      } | [\`${entry.folderName}\`](./${encodeURI(entry.folderName)}/) |`,
    );
  }

  if (entries.length === 0) {
    lines.push('| — | — | *Nothing captured yet* | — | — | — |');
  }

  await fs.writeFile(path.join(root, INDEX_FILE), `${lines.join('\n')}\n`, 'utf8');
}

/** Recursively lists a job folder for the export/zip endpoint. */
export async function listFolderFiles(userId: string, folderName: string): Promise<string[]> {
  const folder = jobFolder(userId, folderName);
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative);
      else out.push(relative);
    }
  };
  await walk(folder, '');
  return out.sort();
}

/** Purges cached media past the retention window (spec §12 "Data minimization"). */
export async function purgeExpiredMedia(userId: string, retentionDays: number): Promise<number> {
  const root = userRoot(userId);
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  const folders = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const mediaDir = path.join(root, folder.name, ARTIFACT_DIRS.media);
    const files = await fs.readdir(mediaDir, { withFileTypes: true }).catch(() => []);
    for (const file of files) {
      if (!file.isFile()) continue;
      const full = path.join(mediaDir, file.name);
      const stat = await fs.stat(full).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) {
        await fs.rm(full, { force: true });
        removed++;
      }
    }
  }
  if (removed > 0) log.info('purged expired media', { userId, removed });
  return removed;
}

/** Removes a job's entire folder — used by data deletion and job delete. */
export async function removeJobFolder(userId: string, folderName: string): Promise<void> {
  await fs.rm(jobFolder(userId, folderName), { recursive: true, force: true });
}
