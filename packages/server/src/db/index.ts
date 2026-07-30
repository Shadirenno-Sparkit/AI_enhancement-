import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

export type Db = Database.Database;

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locates schema.sql whether we are running from `src` (tsx/--watch) or `dist`
 * (compiled). The file is copied next to the compiled output by the build.
 */
function schemaPath(): string {
  const candidates = [
    path.join(here, 'schema.sql'),
    path.join(here, '..', '..', 'src', 'db', 'schema.sql'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`schema.sql not found (looked in: ${candidates.join(', ')})`);
}

let instance: Db | null = null;

export function openDatabase(filePath?: string): Db {
  const target = filePath ?? config().databasePath;
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });

  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Wait rather than throw when a concurrent writer holds the lock; the worker
  // and the API share one file.
  db.pragma('busy_timeout = 5000');
  db.exec(fs.readFileSync(schemaPath(), 'utf8'));
  return db;
}

export function db(): Db {
  if (!instance) instance = openDatabase();
  return instance;
}

export function setDatabase(next: Db | null): void {
  instance = next;
}

export function closeDatabase(): void {
  instance?.close();
  instance = null;
}

/** ISO-8601 UTC timestamp — the only time format written to the DB. */
export function now(): string {
  return new Date().toISOString();
}

/** `YYYY-MM-DD` in UTC, the key used by usage_daily. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
