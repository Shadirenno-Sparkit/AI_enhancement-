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

/**
 * Columns added to existing tables after the first release.
 *
 * `schema.sql` uses CREATE TABLE IF NOT EXISTS, so a database created by an
 * earlier version keeps its original column set — new tables appear but new
 * columns do not. SQLite has no `ADD COLUMN IF NOT EXISTS`, so each addition is
 * applied only when `PRAGMA table_info` says it is missing. Every entry must
 * carry a default or be nullable: existing rows are not rewritten.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: 'jobs', column: 'failure_code', definition: 'TEXT' },
  { table: 'jobs', column: 'required_action', definition: 'TEXT' },
  { table: 'jobs', column: 'input_kind', definition: "TEXT NOT NULL DEFAULT 'link'" },
  { table: 'jobs', column: 'body_text', definition: 'TEXT' },
  { table: 'jobs', column: 'triage_verdict', definition: 'TEXT' },
  { table: 'jobs', column: 'value_score', definition: 'REAL' },
  { table: 'jobs', column: 'domains', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'spec_items', column: 'domain', definition: "TEXT NOT NULL DEFAULT 'ai_workflow'" },
  { table: 'spec_items', column: 'personalized_on', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'specs', column: 'domains', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'specs', column: 'proposed_facts', definition: "TEXT NOT NULL DEFAULT '[]'" },
  { table: 'runs', column: 'confirmed_item_ids', definition: "TEXT NOT NULL DEFAULT '[]'" },
];

function migrate(db: Db): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.length === 0) continue; // table not created yet — schema.sql owns it
    if (columns.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  const cacheColumns = new Set(
    (db.pragma('table_info(extraction_cache)') as { name: string }[]).map((column) => column.name),
  );
  if (!cacheColumns.has('user_id')) {
    db.exec('ALTER TABLE extraction_cache ADD COLUMN user_id TEXT');
    // Legacy entries were globally keyed and may contain private/user-supplied
    // text. Their owner cannot be recovered, so discard this regenerable cache.
    db.exec('DELETE FROM extraction_cache');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_extraction_cache_user ON extraction_cache(user_id)');
}

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
  migrate(db);
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
