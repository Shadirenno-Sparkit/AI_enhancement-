import type {
  FactCategory,
  FactSource,
  LifeContext,
  ProfileFact,
  ProposedFact,
} from '@aiapp/shared';
import { FACT_CATEGORIES, FACT_CATEGORY_LABELS } from '@aiapp/shared';
import { db, now, parseJson } from '../db/index.js';
import { id } from '../util/ids.js';

/**
 * The life context graph (BR-P1…P6).
 *
 * The original analyzer read a post and nothing else, so it could only ever
 * produce advice that would suit anybody. Everything here exists to answer one
 * question before the analyzer runs: *who is this for?*
 *
 * Two rules govern the store, and both are enforced here rather than left to
 * callers:
 *
 *  - **Confirmed facts only leave this module for analysis.** An inferred fact
 *    is a proposal until the user accepts it, so the app cannot quietly build a
 *    profile of someone from things it merely guessed.
 *  - **One value per key.** Re-stating a fact replaces it. Without this the
 *    graph accumulates contradictions ("phone: iPhone 13", "phone: iPhone 15")
 *    and the analyzer has to pick, which it would do invisibly and badly.
 */

interface FactRow {
  fact_id: string;
  user_id: string;
  category: string;
  key: string;
  value: string;
  detail: string | null;
  source: string;
  confidence: number;
  confirmed: number;
  job_id: string | null;
  evidence: string | null;
  created_at: string;
  updated_at: string;
}

function toFact(row: FactRow): ProfileFact {
  return {
    factId: row.fact_id,
    userId: row.user_id,
    category: row.category as FactCategory,
    key: row.key,
    value: row.value,
    detail: row.detail,
    source: row.source as FactSource,
    confidence: row.confidence,
    confirmed: row.confirmed === 1,
    jobId: row.job_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Normalizes a key so `Phone`, `phone ` and `phone` are the same fact. */
export function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

export interface UpsertFactInput {
  userId: string;
  category: FactCategory;
  key: string;
  value: string;
  detail?: string | null;
  source?: FactSource;
  confidence?: number;
  confirmed?: boolean;
  jobId?: string | null;
  evidence?: string | null;
}

/**
 * Writes a fact, replacing any existing value for the same key.
 *
 * A user-stated fact always wins over an inferred one — if someone has told us
 * their phone is an iPhone, a guess from a caption must not overwrite it. An
 * inferred fact targeting an occupied key is dropped rather than queued, so the
 * pending inbox never fills with proposals to change things already settled.
 */
export function upsertFact(input: UpsertFactInput): ProfileFact | null {
  const key = normalizeKey(input.key);
  if (!key || !input.value.trim()) return null;

  const source = input.source ?? 'user_stated';
  const confirmed = input.confirmed ?? (source === 'user_stated' || source === 'onboarding');
  const existing = getFactByKey(input.userId, key);

  if (existing && !confirmed) {
    // An unconfirmed proposal never displaces a fact that is already recorded.
    if (existing.confirmed) return null;
    // …but it may refine a still-pending proposal of its own kind.
  }

  const timestamp = now();
  if (existing) {
    db()
      .prepare(
        `UPDATE profile_facts
            SET category = ?, value = ?, detail = ?, source = ?, confidence = ?,
                confirmed = ?, job_id = ?, evidence = ?, updated_at = ?
          WHERE fact_id = ?`,
      )
      .run(
        input.category,
        input.value.trim().slice(0, 500),
        input.detail?.trim().slice(0, 1000) ?? null,
        source,
        input.confidence ?? 1,
        confirmed ? 1 : 0,
        input.jobId ?? null,
        input.evidence?.slice(0, 500) ?? null,
        timestamp,
        existing.factId,
      );
    return getFactByKey(input.userId, key);
  }

  db()
    .prepare(
      `INSERT INTO profile_facts
         (fact_id, user_id, category, key, value, detail, source, confidence, confirmed, job_id, evidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id('fact'),
      input.userId,
      input.category,
      key,
      input.value.trim().slice(0, 500),
      input.detail?.trim().slice(0, 1000) ?? null,
      source,
      input.confidence ?? 1,
      confirmed ? 1 : 0,
      input.jobId ?? null,
      input.evidence?.slice(0, 500) ?? null,
      timestamp,
      timestamp,
    );
  return getFactByKey(input.userId, key);
}

export function getFactByKey(userId: string, key: string): ProfileFact | null {
  const row = db()
    .prepare('SELECT * FROM profile_facts WHERE user_id = ? AND key = ?')
    .get(userId, normalizeKey(key)) as FactRow | undefined;
  return row ? toFact(row) : null;
}

export function listFacts(userId: string, options: { confirmed?: boolean } = {}): ProfileFact[] {
  const rows =
    options.confirmed === undefined
      ? (db()
          .prepare('SELECT * FROM profile_facts WHERE user_id = ? ORDER BY category, key')
          .all(userId) as FactRow[])
      : (db()
          .prepare(
            'SELECT * FROM profile_facts WHERE user_id = ? AND confirmed = ? ORDER BY category, key',
          )
          .all(userId, options.confirmed ? 1 : 0) as FactRow[]);
  return rows.map(toFact);
}

export function confirmFact(userId: string, factId: string): ProfileFact | null {
  db()
    .prepare('UPDATE profile_facts SET confirmed = 1, source = ?, updated_at = ? WHERE fact_id = ? AND user_id = ?')
    .run('user_stated', now(), factId, userId);
  const row = db()
    .prepare('SELECT * FROM profile_facts WHERE fact_id = ? AND user_id = ?')
    .get(factId, userId) as FactRow | undefined;
  return row ? toFact(row) : null;
}

export function deleteFact(userId: string, factId: string): boolean {
  const result = db()
    .prepare('DELETE FROM profile_facts WHERE fact_id = ? AND user_id = ?')
    .run(factId, userId);
  return result.changes > 0;
}

/**
 * Records facts the analyzer inferred from a capture.
 *
 * Returns how many were newly proposed. Anything targeting a key the user has
 * already settled is silently dropped by `upsertFact`.
 */
export function proposeFacts(userId: string, jobId: string, proposed: ProposedFact[]): number {
  let added = 0;
  for (const fact of proposed.slice(0, 12)) {
    const saved = upsertFact({
      userId,
      category: fact.category,
      key: fact.key,
      value: fact.value,
      detail: fact.detail ?? null,
      source: 'inferred',
      confidence: Math.max(0, Math.min(1, fact.confidence)),
      confirmed: false,
      jobId,
      evidence: fact.evidence,
    });
    if (saved) added++;
  }
  return added;
}

// ─── Context assembly ────────────────────────────────────────────────────────

/** Category order in the brief: identity first, then what they own and prefer. */
const BRIEF_ORDER: FactCategory[] = [
  'identity',
  'household',
  'goal',
  'constraint',
  'preference',
  'device',
  'service',
  'tool',
  'routine',
  'skill',
];

/**
 * Builds the block of prose about the user that is prepended to every analysis
 * prompt.
 *
 * It is deliberately compact. This text rides along on every deep-plan call, so
 * an unbounded profile would quietly inflate the cost of each capture; the cap
 * keeps a rich profile from becoming an expensive one.
 */
export function buildLifeContext(userId: string, options: { maxChars?: number } = {}): LifeContext {
  const all = listFacts(userId);
  const confirmed = all.filter((fact) => fact.confirmed);
  const pending = all.filter((fact) => !fact.confirmed);

  if (confirmed.length === 0) {
    return { facts: [], brief: '', factCount: 0, pendingCount: pending.length };
  }

  const maxChars = options.maxChars ?? 2400;
  const lines: string[] = [];
  const used: ProfileFact[] = [];
  let budget = maxChars;

  for (const category of BRIEF_ORDER) {
    const inCategory = confirmed.filter((fact) => fact.category === category);
    if (inCategory.length === 0) continue;

    const header = `${FACT_CATEGORY_LABELS[category]}:`;
    const entries: string[] = [];
    for (const fact of inCategory) {
      const rendered = fact.detail ? `${fact.value} (${fact.detail})` : fact.value;
      const line = `  - ${fact.key.replace(/_/g, ' ')}: ${rendered}`;
      if (line.length + 1 > budget) break;
      entries.push(line);
      used.push(fact);
      budget -= line.length + 1;
    }
    if (entries.length > 0) lines.push(header, ...entries);
  }

  const brief = lines.length > 0 ? lines.join('\n') : '';
  return { facts: used, brief, factCount: confirmed.length, pendingCount: pending.length };
}

/**
 * How well the app knows this person, 0–1, plus the categories still empty.
 *
 * Used to nudge onboarding: a profile with nothing in it produces generic plans,
 * and the UI should say so rather than let the user wonder why the
 * recommendations feel like they were written for anyone.
 */
export function profileCompleteness(userId: string): { completeness: number; gaps: FactCategory[] } {
  const confirmed = listFacts(userId, { confirmed: true });
  const present = new Set(confirmed.map((fact) => fact.category));
  // Weighted: the categories that most change a recommendation count for more.
  const WEIGHTS: Record<FactCategory, number> = {
    identity: 2,
    preference: 3,
    goal: 3,
    constraint: 2,
    device: 1,
    service: 2,
    tool: 2,
    household: 1,
    routine: 1,
    skill: 1,
  };
  const total = Object.values(WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  const earned = FACT_CATEGORIES.reduce(
    (sum, category) => sum + (present.has(category) ? WEIGHTS[category] : 0),
    0,
  );
  const gaps = FACT_CATEGORIES.filter((category) => !present.has(category));
  return { completeness: Math.round((earned / total) * 100) / 100, gaps };
}

/**
 * Seeds a new account with a starter profile from the signup form.
 * Nothing here is guessed — only what the person typed.
 */
export function seedProfile(userId: string, displayName: string): void {
  if (displayName.trim()) {
    upsertFact({
      userId,
      category: 'identity',
      key: 'name',
      value: displayName.trim(),
      source: 'onboarding',
    });
  }
}

export type { ProfileFact };
export { parseJson };
