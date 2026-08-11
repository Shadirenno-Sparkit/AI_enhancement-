import type {
  Decision,
  DecisionChoice,
  EffortLevel,
  ImpactLevel,
  ItemType,
  LifeDomain,
  Pathway,
  PathwayStance,
  PermissionScope,
  ProposedFact,
  RiskTier,
  Spec,
  SpecItem,
} from '@aiapp/shared';
import { db, now, parseJson } from '../db/index.js';
import { id } from '../util/ids.js';

interface SpecRow {
  spec_id: string;
  job_id: string;
  user_id: string;
  title: string;
  summary: string;
  technical_spec: string;
  no_actionable_items: number;
  domains: string | null;
  proposed_facts: string | null;
  created_at: string;
}

interface ItemRow {
  item_id: string;
  spec_id: string;
  user_id: string;
  ordinal: number;
  title: string;
  type: string;
  why: string;
  proposed_method: string;
  prerequisites: string;
  missing_prerequisites: string;
  effort: string;
  impact: string;
  risk_tier: string;
  scopes: string;
  requires_browser: number;
  parameters: string;
  source_segments: string;
  duplicate_of_item_id: string | null;
  domain: string | null;
  personalized_on: string | null;
}

interface PathwayRow {
  pathway_id: string;
  spec_id: string;
  user_id: string;
  ordinal: number;
  label: string;
  stance: string;
  rationale: string;
  grounded_in_facts: string;
  estimated_minutes: number;
  estimated_cost_usd: number;
  item_ids: string;
  recommended: number;
}

function toItem(row: ItemRow): SpecItem {
  return {
    itemId: row.item_id,
    specId: row.spec_id,
    ordinal: row.ordinal,
    title: row.title,
    type: row.type as ItemType,
    why: row.why,
    proposedMethod: row.proposed_method,
    prerequisites: parseJson<string[]>(row.prerequisites, []),
    missingPrerequisites: parseJson<string[]>(row.missing_prerequisites, []),
    effort: row.effort as EffortLevel,
    impact: row.impact as ImpactLevel,
    riskTier: row.risk_tier as RiskTier,
    scopes: parseJson<PermissionScope[]>(row.scopes, []),
    requiresBrowser: row.requires_browser === 1,
    parameters: parseJson<Record<string, unknown>>(row.parameters, {}),
    sourceSegments: parseJson<number[]>(row.source_segments, []),
    duplicateOfItemId: row.duplicate_of_item_id,
    domain: (row.domain as LifeDomain) ?? 'ai_workflow',
    personalizedOn: parseJson<string[]>(row.personalized_on, []),
  };
}

function toPathway(row: PathwayRow): Pathway {
  return {
    pathwayId: row.pathway_id,
    specId: row.spec_id,
    ordinal: row.ordinal,
    label: row.label,
    stance: row.stance as PathwayStance,
    rationale: row.rationale,
    groundedInFacts: parseJson<string[]>(row.grounded_in_facts, []),
    estimatedMinutes: row.estimated_minutes,
    estimatedCostUsd: row.estimated_cost_usd,
    itemIds: parseJson<string[]>(row.item_ids, []),
    recommended: row.recommended === 1,
  };
}

function toSpec(row: SpecRow, items: SpecItem[], pathways: Pathway[]): Spec {
  return {
    specId: row.spec_id,
    jobId: row.job_id,
    userId: row.user_id,
    title: row.title,
    summaryPlainEnglish: row.summary,
    technicalSpec: row.technical_spec,
    noActionableItems: row.no_actionable_items === 1,
    items,
    pathways,
    domains: parseJson<LifeDomain[]>(row.domains, []),
    proposedFacts: parseJson<ProposedFact[]>(row.proposed_facts, []),
    createdAt: row.created_at,
  };
}

/** A pathway as the analyzer produced it: items referenced by position. */
export interface NewPathway {
  label: string;
  stance: PathwayStance;
  rationale: string;
  groundedInFacts: string[];
  estimatedMinutes: number;
  estimatedCostUsd: number;
  itemIndexes: number[];
  recommended: boolean;
  ordinal: number;
}

export interface NewSpec {
  jobId: string;
  userId: string;
  title: string;
  summaryPlainEnglish: string;
  technicalSpec: string;
  noActionableItems: boolean;
  items: Omit<SpecItem, 'itemId' | 'specId' | 'ordinal'>[];
  pathways?: NewPathway[];
  domains?: LifeDomain[];
  proposedFacts?: ProposedFact[];
}

export function createSpec(input: NewSpec): Spec {
  const specId = id('spec');
  const timestamp = now();
  const database = db();

  const insert = database.transaction(() => {
    // Re-analysis of the same link replaces the previous spec so the review UI
    // never shows two competing versions of the same advice.
    database.prepare('DELETE FROM specs WHERE job_id = ?').run(input.jobId);
    database
      .prepare(
        `INSERT INTO specs (spec_id, job_id, user_id, title, summary, technical_spec,
                            no_actionable_items, domains, proposed_facts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        specId,
        input.jobId,
        input.userId,
        input.title,
        input.summaryPlainEnglish,
        input.technicalSpec,
        input.noActionableItems ? 1 : 0,
        JSON.stringify(input.domains ?? []),
        JSON.stringify(input.proposedFacts ?? []),
        timestamp,
      );

    const stmt = database.prepare(
      `INSERT INTO spec_items (item_id, spec_id, user_id, ordinal, title, type, why, proposed_method,
                               prerequisites, missing_prerequisites, effort, impact, risk_tier, scopes,
                               requires_browser, parameters, source_segments, duplicate_of_item_id,
                               domain, personalized_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Item ids are generated here, so the analyzer's positional pathway
    // references are resolved to real ids in the same transaction.
    const itemIds: string[] = [];
    input.items.forEach((item, index) => {
      const itemId = id('item');
      itemIds.push(itemId);
      stmt.run(
        itemId,
        specId,
        input.userId,
        index,
        item.title,
        item.type,
        item.why,
        item.proposedMethod,
        JSON.stringify(item.prerequisites),
        JSON.stringify(item.missingPrerequisites),
        item.effort,
        item.impact,
        item.riskTier,
        JSON.stringify(item.scopes),
        item.requiresBrowser ? 1 : 0,
        JSON.stringify(item.parameters),
        JSON.stringify(item.sourceSegments),
        item.duplicateOfItemId ?? null,
        item.domain,
        JSON.stringify(item.personalizedOn),
      );
    });

    const pathwayStmt = database.prepare(
      `INSERT INTO pathways (pathway_id, spec_id, user_id, ordinal, label, stance, rationale,
                             grounded_in_facts, estimated_minutes, estimated_cost_usd, item_ids, recommended)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    (input.pathways ?? []).forEach((pathway, index) => {
      pathwayStmt.run(
        id('path'),
        specId,
        input.userId,
        pathway.ordinal ?? index,
        pathway.label,
        pathway.stance,
        pathway.rationale,
        JSON.stringify(pathway.groundedInFacts),
        pathway.estimatedMinutes,
        pathway.estimatedCostUsd,
        JSON.stringify(
          pathway.itemIndexes.map((position) => itemIds[position]).filter((value): value is string => !!value),
        ),
        pathway.recommended ? 1 : 0,
      );
    });
  });
  insert();
  return getSpecUnscoped(specId)!;
}

function loadItems(specId: string): SpecItem[] {
  const rows = db()
    .prepare('SELECT * FROM spec_items WHERE spec_id = ? ORDER BY ordinal ASC')
    .all(specId) as ItemRow[];
  return rows.map(toItem);
}

function loadPathways(specId: string): Pathway[] {
  const rows = db()
    .prepare('SELECT * FROM pathways WHERE spec_id = ? ORDER BY ordinal ASC')
    .all(specId) as PathwayRow[];
  return rows.map(toPathway);
}

export function getSpec(specId: string, userId: string): Spec | null {
  const row = db()
    .prepare('SELECT * FROM specs WHERE spec_id = ? AND user_id = ?')
    .get(specId, userId) as SpecRow | undefined;
  return row ? toSpec(row, loadItems(specId), loadPathways(specId)) : null;
}

export function getSpecUnscoped(specId: string): Spec | null {
  const row = db().prepare('SELECT * FROM specs WHERE spec_id = ?').get(specId) as SpecRow | undefined;
  return row ? toSpec(row, loadItems(specId), loadPathways(specId)) : null;
}

export function getSpecByJob(jobId: string): Spec | null {
  const row = db().prepare('SELECT * FROM specs WHERE job_id = ?').get(jobId) as SpecRow | undefined;
  return row ? toSpec(row, loadItems(row.spec_id), loadPathways(row.spec_id)) : null;
}

export function getItem(itemId: string, userId: string): SpecItem | null {
  const row = db()
    .prepare('SELECT * FROM spec_items WHERE item_id = ? AND user_id = ?')
    .get(itemId, userId) as ItemRow | undefined;
  return row ? toItem(row) : null;
}

export function updateItemParameters(itemId: string, parameters: Record<string, unknown>): void {
  db().prepare('UPDATE spec_items SET parameters = ? WHERE item_id = ?').run(JSON.stringify(parameters), itemId);
}

/**
 * Titles of items this user already approved, used for duplicate detection
 * across links (BR-A7).
 */
export function previouslyApprovedItems(
  userId: string,
  excludeSpecId?: string,
): { itemId: string; title: string; type: string }[] {
  const rows = db()
    .prepare(
      `SELECT i.item_id, i.title, i.type
         FROM spec_items i
         JOIN decisions d ON d.item_id = i.item_id
        WHERE i.user_id = ? AND d.decision = 'approve' AND (? IS NULL OR i.spec_id != ?)
        ORDER BY d.decided_at DESC
        LIMIT 200`,
    )
    .all(userId, excludeSpecId ?? null, excludeSpecId ?? null) as {
    item_id: string;
    title: string;
    type: string;
  }[];
  return rows.map((r) => ({ itemId: r.item_id, title: r.title, type: r.type }));
}

// ─── Decisions ───────────────────────────────────────────────────────────────

interface DecisionRow {
  decision_id: string;
  spec_id: string;
  item_id: string;
  user_id: string;
  decision: string;
  edits: string | null;
  decided_at: string;
}

function toDecision(row: DecisionRow): Decision {
  return {
    decisionId: row.decision_id,
    specId: row.spec_id,
    itemId: row.item_id,
    userId: row.user_id,
    decision: row.decision as DecisionChoice,
    edits: parseJson<Record<string, unknown> | null>(row.edits, null),
    decidedAt: row.decided_at,
  };
}

export function recordDecision(input: {
  specId: string;
  itemId: string;
  userId: string;
  decision: DecisionChoice;
  edits?: Record<string, unknown> | null;
}): Decision {
  const timestamp = now();
  db()
    .prepare(
      `INSERT INTO decisions (decision_id, spec_id, item_id, user_id, decision, edits, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET
         decision = excluded.decision, edits = excluded.edits, decided_at = excluded.decided_at`,
    )
    .run(
      id('dec'),
      input.specId,
      input.itemId,
      input.userId,
      input.decision,
      input.edits ? JSON.stringify(input.edits) : null,
      timestamp,
    );
  return getDecisionForItem(input.itemId)!;
}

export function getDecisionForItem(itemId: string): Decision | null {
  const row = db().prepare('SELECT * FROM decisions WHERE item_id = ?').get(itemId) as DecisionRow | undefined;
  return row ? toDecision(row) : null;
}

export function listDecisions(specId: string): Decision[] {
  const rows = db()
    .prepare('SELECT * FROM decisions WHERE spec_id = ? ORDER BY decided_at ASC')
    .all(specId) as DecisionRow[];
  return rows.map(toDecision);
}

/**
 * Approve/forgo counts per item type. Feeds preference-aware ranking so the
 * categories a user always approves surface first (BR-R4, O6).
 */
export function decisionStatsByType(userId: string): Record<string, { approve: number; forgo: number; defer: number }> {
  const rows = db()
    .prepare(
      `SELECT i.type AS type, d.decision AS decision, COUNT(*) AS n
         FROM decisions d JOIN spec_items i ON i.item_id = d.item_id
        WHERE d.user_id = ?
        GROUP BY i.type, d.decision`,
    )
    .all(userId) as { type: string; decision: string; n: number }[];
  const out: Record<string, { approve: number; forgo: number; defer: number }> = {};
  for (const row of rows) {
    const bucket = (out[row.type] ??= { approve: 0, forgo: 0, defer: 0 });
    if (row.decision === 'approve') bucket.approve = row.n;
    else if (row.decision === 'forgo') bucket.forgo = row.n;
    else if (row.decision === 'defer') bucket.defer = row.n;
  }
  return out;
}
