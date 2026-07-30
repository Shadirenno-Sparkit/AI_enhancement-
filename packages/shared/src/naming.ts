import type { Platform } from './types.js';

/** Lower-case, hyphenated, filesystem-safe slug. */
export function slugify(input: string, maxLength = 48): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) return slug || 'untitled';
  // Cut at a word boundary so folder names stay readable.
  const cut = slug.slice(0, maxLength);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > maxLength * 0.6 ? cut.slice(0, lastDash) : cut) || 'untitled';
}

/**
 * Per-link folder name: `YYYY-MM-DD__platform__short-title` (BR-F3, spec §11.2).
 * Browsable at a glance without opening anything.
 */
export function folderNameFor(date: Date | string, platform: Platform, title: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const iso = Number.isNaN(d.getTime()) ? new Date() : d;
  const yyyy = iso.getUTCFullYear();
  const mm = String(iso.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(iso.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}__${platform}__${slugify(title)}`;
}

/** Canonical file names inside a per-link folder. Spec §11.1. */
export const ARTIFACT_FILES = {
  source: '00_source.json',
  transcriptVtt: '01_transcript.vtt',
  transcriptTxt: '01_transcript.txt',
  insights: '02_extracted-insights.json',
  summary: '03_summary.md',
  spec: '04_spec.md',
  plan: '05_implementation-plan.md',
  decisions: '06_decisions.json',
  runLog: '07_run-log.md',
} as const;

export const ARTIFACT_DIRS = {
  artifacts: 'artifacts',
  media: 'media',
} as const;

export const INDEX_FILE = '_index.md';
export const ROOT_FOLDER_NAME = 'AI Enhancement App';

/** Rejects path traversal and separators in anything used as a path component. */
export function isSafePathComponent(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}
