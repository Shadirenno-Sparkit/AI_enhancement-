import bcrypt from 'bcryptjs';
import type { User, UserPreferences } from '@aiapp/shared';
import { config } from '../config.js';
import { db, now, parseJson, today } from '../db/index.js';
import { id, sha256 } from '../util/ids.js';

interface UserRow {
  user_id: string;
  email: string;
  display_name: string;
  password_hash: string;
  preferences: string;
  created_at: string;
  updated_at: string;
}

export function defaultPreferences(): UserPreferences {
  const cfg = config();
  return {
    trustPosture: cfg.defaultTrustPosture,
    autoImplementTiers: null,
    notifyChannels: cfg.notifyChannels,
    quietHours: cfg.quietHours,
    desktopFolder: null,
    weeklyDigest: true,
    dryRunFirst: false,
    personalContext: null,
  };
}

function toUser(row: UserRow): User {
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
    preferences: { ...defaultPreferences(), ...parseJson<Partial<UserPreferences>>(row.preferences, {}) },
  };
}

export function createUser(email: string, password: string, displayName?: string): User {
  const userId = id('usr');
  const timestamp = now();
  const hash = bcrypt.hashSync(password, 12);
  db()
    .prepare(
      `INSERT INTO users (user_id, email, display_name, password_hash, preferences, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      userId,
      email.toLowerCase().trim(),
      displayName?.trim() || email.split('@')[0] || 'User',
      hash,
      JSON.stringify(defaultPreferences()),
      timestamp,
      timestamp,
    );
  return getUserById(userId)!;
}

export function getUserById(userId: string): User | null {
  const row = db().prepare('SELECT * FROM users WHERE user_id = ?').get(userId) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function getUserByEmail(email: string): User | null {
  const row = db()
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(email.toLowerCase().trim()) as UserRow | undefined;
  return row ? toUser(row) : null;
}

export function verifyPassword(email: string, password: string): User | null {
  const row = db()
    .prepare('SELECT * FROM users WHERE email = ?')
    .get(email.toLowerCase().trim()) as UserRow | undefined;
  if (!row) {
    // Hash anyway so a missing account and a wrong password take similar time.
    bcrypt.compareSync(password, '$2a$12$abcdefghijklmnopqrstuvwxyz012345678901234567890123456');
    return null;
  }
  return bcrypt.compareSync(password, row.password_hash) ? toUser(row) : null;
}

export function updatePreferences(userId: string, patch: Partial<UserPreferences>): User {
  const current = getUserById(userId);
  if (!current) throw new Error(`No such user: ${userId}`);
  const merged = { ...current.preferences, ...patch };
  db()
    .prepare('UPDATE users SET preferences = ?, updated_at = ? WHERE user_id = ?')
    .run(JSON.stringify(merged), now(), userId);
  return getUserById(userId)!;
}

export function countUsers(): number {
  const row = db().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  return row.n;
}

/** Cascades through every user-owned table. DELETE /v1/users/me/data (spec §8, §12). */
export function deleteUserData(userId: string, options: { keepAccount: boolean }): void {
  const database = db();
  const wipe = database.transaction(() => {
    // Ordered children-first; foreign keys would handle it, but being explicit
    // keeps the guarantee true even if a table loses its FK during a migration.
    database.prepare('DELETE FROM decisions WHERE user_id = ?').run(userId);
    database.prepare('DELETE FROM spec_items WHERE user_id = ?').run(userId);
    database.prepare('DELETE FROM specs WHERE user_id = ?').run(userId);
    database.prepare('DELETE FROM runs WHERE user_id = ?').run(userId);
    database.prepare('DELETE FROM insight_sources WHERE user_id = ?').run(userId);
    database
      .prepare('DELETE FROM job_queue WHERE job_id IN (SELECT job_id FROM jobs WHERE user_id = ?)')
      .run(userId);
    database.prepare('DELETE FROM jobs WHERE user_id = ?').run(userId);
    database.prepare('DELETE FROM scheduled_tasks WHERE user_id = ?').run(userId);
    database.prepare('DELETE FROM connectors WHERE user_id = ?').run(userId);
    database.prepare('DELETE FROM notifications WHERE user_id = ?').run(userId);
    database.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
    database.prepare('DELETE FROM usage_daily WHERE user_id = ?').run(userId);
    database.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
    // The audit log is deliberately preserved but de-identified: the operator
    // keeps the record that actions happened without retaining who they belonged to.
    database.prepare("UPDATE audit_log SET user_id = NULL, detail = '[erased]' WHERE user_id = ?").run(userId);
    if (!options.keepAccount) database.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
  });
  wipe();
}

// ─── Refresh tokens ──────────────────────────────────────────────────────────

export function storeRefreshToken(userId: string, token: string, ttlSeconds: number): void {
  const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  db()
    .prepare('INSERT OR REPLACE INTO refresh_tokens (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, expires, now());
}

export function consumeRefreshToken(token: string): string | null {
  const hash = sha256(token);
  const row = db()
    .prepare('SELECT user_id, expires_at FROM refresh_tokens WHERE token_hash = ?')
    .get(hash) as { user_id: string; expires_at: string } | undefined;
  if (!row) return null;
  // Single-use: rotate on every refresh so a stolen token has a short life.
  db().prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').run(hash);
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.user_id;
}

export function revokeAllRefreshTokens(userId: string): void {
  db().prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
}

// ─── Usage / budgets ─────────────────────────────────────────────────────────

export function recordUsage(
  userId: string,
  delta: { usd?: number; asrSeconds?: number; modelTokens?: number; jobs?: number },
): void {
  db()
    .prepare(
      `INSERT INTO usage_daily (user_id, day, usd, asr_seconds, model_tokens, jobs)
       VALUES (@userId, @day, @usd, @asr, @tokens, @jobs)
       ON CONFLICT(user_id, day) DO UPDATE SET
         usd = usd + @usd,
         asr_seconds = asr_seconds + @asr,
         model_tokens = model_tokens + @tokens,
         jobs = jobs + @jobs`,
    )
    .run({
      userId,
      day: today(),
      usd: delta.usd ?? 0,
      asr: delta.asrSeconds ?? 0,
      tokens: delta.modelTokens ?? 0,
      jobs: delta.jobs ?? 0,
    });
}

export function usageToday(userId: string): { usd: number; asrSeconds: number; modelTokens: number; jobs: number } {
  const row = db()
    .prepare('SELECT usd, asr_seconds, model_tokens, jobs FROM usage_daily WHERE user_id = ? AND day = ?')
    .get(userId, today()) as
    | { usd: number; asr_seconds: number; model_tokens: number; jobs: number }
    | undefined;
  return {
    usd: row?.usd ?? 0,
    asrSeconds: row?.asr_seconds ?? 0,
    modelTokens: row?.model_tokens ?? 0,
    jobs: row?.jobs ?? 0,
  };
}

export function usageTotal(userId: string): { usd: number; jobs: number } {
  const row = db()
    .prepare('SELECT COALESCE(SUM(usd), 0) AS usd, COALESCE(SUM(jobs), 0) AS jobs FROM usage_daily WHERE user_id = ?')
    .get(userId) as { usd: number; jobs: number };
  return row;
}
