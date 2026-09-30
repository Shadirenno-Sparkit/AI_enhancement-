import type {
  EffortLevel,
  ImpactLevel,
  InputKind,
  ItemType,
  LifeContext,
  LifeDomain,
  Pathway,
  PathwayStance,
  Platform,
  ProposedFact,
  SpecItem,
  TriageResult,
} from '@aiapp/shared';
import {
  EFFORT_LEVELS,
  FACT_CATEGORIES,
  IMPACT_LEVELS,
  INPUT_KIND_LABELS,
  ITEM_TYPES,
  ITEM_TYPE_RISK,
  ITEM_TYPE_SCOPES,
  LIFE_DOMAINS,
  PATHWAY_STANCES,
  PLATFORM_LABELS,
  slugify,
} from '@aiapp/shared';
import type { FactCategory } from '@aiapp/shared';
import { findMissingPrerequisites, listConnectors } from '../repo/connectors.js';
import { getUserById } from '../repo/users.js';
import { previouslyApprovedItems } from '../repo/specs.js';
import { completeJson, llm, type LlmProviderName } from '../providers/llm.js';
import { createLogger } from '../util/logger.js';
import {
  effortFor,
  extractCandidateTips,
  impactFor,
  inferPrerequisites,
  methodFor,
  stripAdviceFraming,
  titleFromTip,
  whyFor,
} from './heuristics.js';

const log = createLogger('analysis');

export type DraftItem = Omit<SpecItem, 'itemId' | 'specId' | 'ordinal'>;

/**
 * A pathway before its items have ids. The model groups items by their position
 * in the items array; `createSpec` resolves those to real item ids once written.
 */
export type DraftPathway = Omit<Pathway, 'pathwayId' | 'specId' | 'itemIds'> & {
  itemIndexes: number[];
};

export interface AnalysisResult {
  title: string;
  summaryPlainEnglish: string;
  technicalSpec: string;
  items: DraftItem[];
  pathways: DraftPathway[];
  domains: LifeDomain[];
  proposedFacts: ProposedFact[];
  noActionableItems: boolean;
  usage: { modelTokens: number; usd: number };
  /** Which analyzer produced the result — shown in the UI for transparency. */
  analyzer: LlmProviderName;
}

export interface AnalysisInput {
  userId: string;
  mergedText: string;
  platform: Platform;
  inputKind: InputKind;
  url: string;
  postTitle?: string | null;
  author?: string | null;
  lowConfidence: boolean;
  overallConfidence: number;
  /** What the app knows about the person this plan is for. */
  lifeContext: LifeContext;
  /** Phase-A verdict, when one was produced. */
  triage?: TriageResult | null;
  /** Domains the user has muted; nothing is proposed in them. */
  mutedDomains?: LifeDomain[];
  /** Whether the analyzer may propose additions to the life context graph. */
  learnAboutMe?: boolean;
}

const SYSTEM_PROMPT = `You turn something a person encountered in their day into a plan they can actually act on.

The input may be a social post, an article, a note they typed, something they overheard and dictated,
or a photo of a page. Each line is tagged with its index and where it came from, e.g.
  [3] (author captions @00:12) Set a standing instruction to keep answers short.
Sources ranked by reliability: author captions > post caption > on-screen text > speech-to-text > page text.

You are given a profile of the specific person this is for. Use it. The difference between this product
and a summarizer is that you answer "what should *this person* do about this?" rather than "what does
this say?". A recommendation that would suit anybody is a failure, even when it is accurate.

Your job:
1. Work out what the content is genuinely offering this person.
2. Write a plain-English summary addressed to them.
3. Produce discrete, independently approvable items.
4. Group those items into 2–3 PATHWAYS — different routes to the same benefit, with different
   trade-offs of time, money and depth. Mark exactly one as recommended, and justify that choice
   using specific facts from their profile.

Hard rules:
- Ground everything in the supplied text. Never invent advice that is not there.
- Ground personalization in the supplied profile. Never invent facts about the person.
  If you say "because you prefer X", X must appear in their profile. If the profile is empty,
  produce a single balanced pathway and say plainly that you do not know enough about them yet.
- Every successfully retrieved capture must produce at least one useful outcome. If it contains direct
  advice, turn that advice into an implementation. If it is commentary, entertainment, an ad, or a
  mental model without an explicit instruction, create one grounded generate_file application note.
  Preserve what the source actually says and label the proposed experiment as the app's application,
  not as advice the creator stated. Never return an empty items array for retrieved content.
- Do not split one idea into several items to pad a pathway, and do not merge genuinely separate ideas.
- Speech-to-text and OCR make mistakes. If a line is garbled, interpret it charitably or leave it out;
  never build an item on text you cannot read.
- Never propose an item that spends money, contacts another person, or acts on someone's health or
  finances as though it were settled. Those items PREPARE the action — an order to review, a draft to
  send, a question to ask a professional — and the person takes the last step.

Item types (choose the most specific that fits):
  Acting on their AI environment:
    create_skill      a reusable routine/skill/command they can invoke again
    set_instruction   a standing instruction or system-prompt change
    schedule_task     recurring or deferred work ("every morning", "each Friday")
    connect_tool      wiring up a connector/integration the advice depends on
    download_file     fetching a resource the content points at
    generate_file     producing a template, checklist, prompt library or starter file
    configure_setting a one-time setting or toggle change
    run_command       a command-line step (use sparingly; highest friction)
    create_project    a whole workspace/project with its own instructions and skills
    automation_workflow  a multi-step automation across tools (exported as an n8n workflow)
  Acting on the rest of their life:
    acquire_media     get a book/audiobook/course — pick the FORMAT their profile says they use
    purchase          a product or service worth buying
    build_habit       a recurring practice, with a concrete trigger and cadence
    learn_topic       a study plan with sequence and checkpoints
    contact_person    reach out to someone — produces a draft, never sends
    research_topic    go find something out before deciding
    financial_review  examine a rate, fee or subscription — produces questions, not transactions

Domains: ai_workflow learning money health career home relationships travel other

When in doubt, generate_file is a good home for anything worth keeping — a plan, a checklist, a script
to say out loud, a recipe. Write the real content, not a description of it.

Return ONLY JSON matching this shape:
{
  "title": "short title, max 8 words",
  "summary": "2-4 sentences, plain English, second person, saying what this is and why it is worth their time",
  "domains": ["learning"],
  "noActionableItems": false,
  "items": [
    {
      "title": "imperative, max 12 words",
      "type": "acquire_media",
      "domain": "learning",
      "why": "one or two sentences on the benefit and what changes for them",
      "proposedMethod": "concretely what should be done to make it real",
      "personalizedOn": ["audiobook_preference", "commute"],
      "prerequisites": ["audible account"],
      "effort": "low",
      "impact": "high",
      "requiresBrowser": false,
      "sourceSegments": [3, 7],
      "parameters": { "title": "...", "format": "audiobook" }
    }
  ],
  "pathways": [
    {
      "label": "Listen on the commute",
      "stance": "fastest",
      "rationale": "You listen to audiobooks on a 40-minute commute, so this costs you no extra time.",
      "groundedInFacts": ["audiobook_preference", "commute"],
      "estimatedMinutes": 0,
      "estimatedCostUsd": 15,
      "itemIndexes": [0, 2],
      "recommended": true
    }
  ],
  "proposedFacts": [
    {
      "category": "preference",
      "key": "note_taking_tool",
      "value": "Obsidian",
      "confidence": 0.7,
      "evidence": "They wrote 'my Obsidian vault' in the note."
    }
  ]
}

"personalizedOn" and "groundedInFacts" list profile keys you actually used. Leave them empty rather
than guessing — they are shown to the user as the reason a recommendation was made, so a wrong entry
reads as the app claiming to know something about them that it does not.

"itemIndexes" are positions in your own items array. Every item must belong to at least one pathway.
Pathway stances: fastest, deepest, cheapest, balanced, hands_off.

"proposedFacts" are things you noticed about the person that are not yet in their profile. They are
shown for confirmation and never applied silently. Only include something the content genuinely
evidences about THEM — not about the world, and not about the author of the content.

The "parameters" object is what the implementation engine consumes. Populate it richly:
  create_skill      { "name": kebab-case, "description": string, "body": full markdown of the skill }
  set_instruction   { "instruction": the exact sentence to adopt }
  schedule_task     { "name": string, "cron": 5-field cron, "timezone": IANA zone, "description": string }
  connect_tool      { "kind": "gmail"|"slack"|"calendar"|..., "steps": [string] }
  generate_file     { "filename": "name.md", "content": full file content }
  download_file     { "url": string or null, "filename": string }
  configure_setting { "setting": string, "value": string, "steps": [string] }
  run_command       { "command": string, "explanation": string }
  create_project    { "name": string, "purpose": string, "instructions": string, "skills": [{"name","body"}] }
  automation_workflow { "name": string, "trigger": string, "steps": [{"name","tool","action"}] }
  acquire_media     { "title": string, "author": string, "format": "audiobook"|"ebook"|"print"|"course",
                      "where": string, "estimatedCostUsd": number, "why_this_format": string }
  purchase          { "item": string, "estimatedCostUsd": number, "where": string, "checkFirst": [string] }
  build_habit       { "habit": string, "cadence": string, "trigger": string, "cron": string, "successLooksLike": string }
  learn_topic       { "topic": string, "sequence": [string], "checkpoints": [string], "estimatedHours": number }
  contact_person    { "who": string, "channel": string, "draft": full message text, "goal": string }
  research_topic    { "question": string, "sources": [string], "decidesWhat": string }
  financial_review  { "whatToCheck": string, "questions": [string], "potentialSavingUsd": number }
Write real, usable content in these fields — a skill body, a habit plan or an outreach draft should be
complete enough to use as-is.`;

interface ModelResponse {
  title?: string;
  summary?: string;
  domains?: unknown;
  noActionableItems?: boolean;
  items?: {
    title?: string;
    type?: string;
    domain?: string;
    why?: string;
    proposedMethod?: string;
    personalizedOn?: unknown;
    prerequisites?: unknown;
    effort?: string;
    impact?: string;
    requiresBrowser?: boolean;
    sourceSegments?: unknown;
    parameters?: Record<string, unknown>;
  }[];
  pathways?: {
    label?: string;
    stance?: string;
    rationale?: string;
    groundedInFacts?: unknown;
    estimatedMinutes?: number;
    estimatedCostUsd?: number;
    itemIndexes?: unknown;
    recommended?: boolean;
  }[];
  proposedFacts?: {
    category?: string;
    key?: string;
    value?: string;
    detail?: string;
    confidence?: number;
    evidence?: string;
  }[];
}

/**
 * Insight Extractor + Spec Generator + Feature Decomposer (spec §4.4).
 *
 * Uses Claude when a key is configured, and falls back to the rule-based
 * extractor otherwise — or when the model call fails or returns nonsense — so
 * the pipeline always reaches SPEC_READY with grounded output.
 */
/** An empty profile: the shape used when nothing is known about the user yet. */
const NO_CONTEXT: LifeContext = { facts: [], brief: '', factCount: 0, pendingCount: 0 };

export async function analyze(rawInput: AnalysisInput): Promise<AnalysisResult> {
  // Normalized up front so a caller that omits the profile gets generic output
  // rather than a crash. Analysis failing outright is far worse than analysis
  // that simply has nothing to personalize against.
  const input: AnalysisInput = {
    ...rawInput,
    inputKind: rawInput.inputKind ?? 'link',
    lifeContext: rawInput.lifeContext ?? NO_CONTEXT,
  };

  if (!input.mergedText.trim()) {
    throw new Error('Analysis requires extracted source content.');
  }

  const modelResult = llm().live ? await analyzeWithModel(input) : null;
  const result = modelResult ?? analyzeOffline(input);

  // Domains the user has muted are dropped after analysis rather than being
  // described in the prompt: a negative instruction ("never mention health")
  // is followed unreliably, whereas a filter here is absolute.
  const muted = new Set(input.mutedDomains ?? []);
  if (muted.size > 0) {
    const kept = new Set<number>();
    result.items = result.items.filter((item, index) => {
      const keep = !muted.has(item.domain);
      if (keep) kept.add(index);
      return keep;
    });
    result.pathways = remapPathways(result.pathways, kept);
    result.domains = result.domains.filter((domain) => !muted.has(domain));
    if (result.items.length === 0) result.noActionableItems = true;
  }

  if (input.learnAboutMe === false) result.proposedFacts = [];

  // Prerequisite gap check runs on both paths: only the server knows which
  // connectors this user actually has (BR-A6).
  for (const item of result.items) {
    item.missingPrerequisites = findMissingPrerequisites(input.userId, item.prerequisites);
  }
  markDuplicates(input.userId, result.items);

  return result;
}

/**
 * The block of prompt that makes suggestions land in this person's actual week.
 *
 * Two sources, both already in the database: what they wrote about themselves,
 * and which tools they have genuinely connected. Naming the connected tools
 * matters as much as the prose — it stops the model proposing a Notion workflow
 * to someone who has never connected Notion.
 */
function describeTheirLife(userId: string): string {
  const parts: string[] = [];

  const user = getUserById(userId);
  const context = user?.preferences.personalContext?.trim();
  if (context) {
    parts.push(`Here is what this person has told us about their life:\n${context.slice(0, 4000)}`);
  }

  const connected = listConnectors(userId)
    .filter((connector) => connector.configured && !connector.kind.startsWith('social-'))
    .map((connector) => connector.label);
  if (connected.length > 0) {
    parts.push(`Tools they have actually connected: ${connected.join(', ')}.`);
  }

  if (parts.length === 0) {
    return (
      'You know nothing about this person yet. Keep the items concrete and universally doable, and note ' +
      'in the summary that they would get sharper once the app knows their tools and routine.\n\n'
    );
  }
  return `${parts.join('\n\n')}\n\nUse this. Name their specific tools, places and people where it fits.\n\n`;
}

/**
 * Rebuilds pathway membership after items have been removed.
 *
 * Item indexes are positional, so dropping an item silently re-points every
 * later index at the wrong thing. Pathways left with no items are discarded.
 */
function remapPathways(pathways: DraftPathway[], keptIndexes: Set<number>): DraftPathway[] {
  const remap = new Map<number, number>();
  let next = 0;
  for (const original of [...keptIndexes].sort((a, b) => a - b)) remap.set(original, next++);

  return pathways
    .map((pathway) => ({
      ...pathway,
      itemIndexes: pathway.itemIndexes
        .filter((index) => remap.has(index))
        .map((index) => remap.get(index)!),
    }))
    .filter((pathway) => pathway.itemIndexes.length > 0);
}

async function analyzeWithModel(input: AnalysisInput): Promise<AnalysisResult | null> {
  const confidenceNote = input.lowConfidence
    ? `\n\nNOTE: this extraction is low confidence (${input.overallConfidence.toFixed(2)}). Be conservative — prefer fewer, well-supported items over speculative ones.`
    : '';

  const profileBlock = input.lifeContext.brief
    ? `\n--- ABOUT THIS PERSON ---\n${input.lifeContext.brief}\n--- END PROFILE ---\n`
    : '\n--- ABOUT THIS PERSON ---\n(nothing recorded yet)\n--- END PROFILE ---\n' +
      'Their profile is empty, so you cannot personalize. Produce one balanced pathway and say in the\n' +
      'summary that filling in their profile would let you tailor this properly. Do not guess at\n' +
      'preferences to fill the gap.\n';

  const triageNote = input.triage
    ? `\nTriage read this as ${input.triage.verdict} in ${input.triage.domains.join(', ')} — "${input.triage.headline}"\n`
    : '';

  const sourceLine =
    input.inputKind === 'link'
      ? `Platform: ${PLATFORM_LABELS[input.platform]}\nURL: ${input.url}\n`
      : `Captured as: ${INPUT_KIND_LABELS[input.inputKind]}\n`;

  const response = await completeJson<ModelResponse>({
    system: SYSTEM_PROMPT,
    prompt:
      describeTheirLife(input.userId) +
      sourceLine +
      (input.postTitle ? `Title: ${input.postTitle}\n` : '') +
      (input.author ? `Author: ${input.author}\n` : '') +
      profileBlock +
      triageNote +
      `\n--- CAPTURED CONTENT ---\n${input.mergedText.slice(0, 60_000)}\n--- END ---${confidenceNote}`,
    maxTokens: 8192,
  });

  if (!response) {
    log.warn('model analysis unavailable — falling back to the offline analyzer');
    return null;
  }

  const body = response.value;
  const items = (body.items ?? [])
    .map((raw) => normalizeModelItem(raw))
    .filter((item): item is DraftItem => item !== null);

  const summary = (body.summary ?? '').trim();
  if (!summary) return null;

  if (items.length === 0) {
    return learningFallback(
      input,
      summary,
      {
        modelTokens: response.usage.inputTokens + response.usage.outputTokens,
        usd: response.usage.usd,
      },
      llm().name,
    );
  }

  const knownKeys = new Set(input.lifeContext.facts.map((fact) => fact.key));
  const pathways = normalizePathways(body.pathways, items.length, knownKeys);

  // A claim of personalization is only kept when it names a fact we actually
  // hold. Otherwise the UI would render "because you prefer…" for a preference
  // the user never told us, which is worse than no personalization at all.
  for (const item of items) {
    item.personalizedOn = item.personalizedOn.filter((key) => knownKeys.has(key));
  }

  const domains = normalizeDomains(body.domains, items);

  return {
    title: (body.title ?? input.postTitle ?? 'Capture').trim().slice(0, 120),
    summaryPlainEnglish: summary,
    technicalSpec: renderTechnicalSpec(input, summary, items, pathways),
    items,
    pathways,
    domains,
    proposedFacts: normalizeProposedFacts(body.proposedFacts, knownKeys),
    noActionableItems: false,
    usage: {
      modelTokens: response.usage.inputTokens + response.usage.outputTokens,
      usd: response.usage.usd,
    },
    analyzer: llm().name,
  };
}

/**
 * Validates the model's pathway grouping.
 *
 * Two invariants matter: every item must be reachable from some pathway (an
 * orphaned item would be invisible in a pathway-driven UI), and exactly one
 * pathway may be recommended.
 */
function normalizePathways(
  raw: ModelResponse['pathways'],
  itemCount: number,
  knownKeys: Set<string>,
): DraftPathway[] {
  if (itemCount === 0) return [];

  const pathways: DraftPathway[] = (raw ?? [])
    .map((entry, index) => {
      const itemIndexes = Array.isArray(entry.itemIndexes)
        ? [
            ...new Set(
              entry.itemIndexes.filter(
                (value): value is number =>
                  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < itemCount,
              ),
            ),
          ]
        : [];
      const label = (entry.label ?? '').trim();
      if (!label || itemIndexes.length === 0) return null;

      const stance: PathwayStance = (PATHWAY_STANCES as readonly string[]).includes(entry.stance ?? '')
        ? (entry.stance as PathwayStance)
        : 'balanced';

      return {
        label: label.slice(0, 80),
        stance,
        rationale: (entry.rationale ?? '').trim().slice(0, 600),
        groundedInFacts: Array.isArray(entry.groundedInFacts)
          ? entry.groundedInFacts.filter(
              (key): key is string => typeof key === 'string' && knownKeys.has(key),
            )
          : [],
        estimatedMinutes: Math.max(0, Math.round(Number(entry.estimatedMinutes) || 0)),
        estimatedCostUsd: Math.max(0, Number(entry.estimatedCostUsd) || 0),
        itemIndexes,
        recommended: entry.recommended === true,
        ordinal: index,
      };
    })
    .filter((pathway): pathway is DraftPathway => pathway !== null);

  if (pathways.length === 0) return [];

  // Any item the model forgot to place goes on the recommended route rather
  // than disappearing from the review screen.
  const placed = new Set(pathways.flatMap((pathway) => pathway.itemIndexes));
  const orphans = Array.from({ length: itemCount }, (_, index) => index).filter((index) => !placed.has(index));

  const recommendedIndex = Math.max(
    0,
    pathways.findIndex((pathway) => pathway.recommended),
  );
  if (orphans.length > 0) {
    pathways[recommendedIndex]!.itemIndexes = [
      ...new Set([...pathways[recommendedIndex]!.itemIndexes, ...orphans]),
    ].sort((a, b) => a - b);
  }

  pathways.forEach((pathway, index) => {
    pathway.recommended = index === recommendedIndex;
    pathway.ordinal = index;
  });

  return pathways;
}

function normalizeDomains(raw: unknown, items: DraftItem[]): LifeDomain[] {
  const fromModel = Array.isArray(raw)
    ? (raw.filter((domain): domain is LifeDomain =>
        (LIFE_DOMAINS as readonly string[]).includes(domain as string),
      ) as LifeDomain[])
    : [];
  if (fromModel.length > 0) return [...new Set(fromModel)].slice(0, 4);
  // Fall back to whatever the items themselves claim.
  return [...new Set(items.map((item) => item.domain))].slice(0, 4);
}

function normalizeProposedFacts(
  raw: ModelResponse['proposedFacts'],
  knownKeys: Set<string>,
): ProposedFact[] {
  return (raw ?? [])
    .map((entry): ProposedFact | null => {
      const key = (entry.key ?? '').trim();
      const value = (entry.value ?? '').trim();
      const category = entry.category as FactCategory;
      if (!key || !value) return null;
      if (!(FACT_CATEGORIES as readonly string[]).includes(category)) return null;
      // Never re-propose something already on file.
      if (knownKeys.has(key)) return null;
      return {
        category,
        key: key.slice(0, 60),
        value: value.slice(0, 300),
        detail: entry.detail?.trim().slice(0, 500) ?? null,
        confidence: Math.max(0, Math.min(1, Number(entry.confidence) || 0.5)),
        evidence: (entry.evidence ?? '').trim().slice(0, 400),
      };
    })
    .filter((fact): fact is ProposedFact => fact !== null)
    .slice(0, 8);
}

function normalizeModelItem(raw: NonNullable<ModelResponse['items']>[number]): DraftItem | null {
  const title = (raw.title ?? '').trim();
  if (!title) return null;

  const type: ItemType = (ITEM_TYPES as readonly string[]).includes(raw.type ?? '')
    ? (raw.type as ItemType)
    : 'generate_file';
  const effort: EffortLevel = (EFFORT_LEVELS as readonly string[]).includes(raw.effort ?? '')
    ? (raw.effort as EffortLevel)
    : effortFor(type);
  const impact: ImpactLevel = (IMPACT_LEVELS as readonly string[]).includes(raw.impact ?? '')
    ? (raw.impact as ImpactLevel)
    : impactFor(type);

  const prerequisites = Array.isArray(raw.prerequisites)
    ? raw.prerequisites.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).slice(0, 8)
    : [];
  const sourceSegments = Array.isArray(raw.sourceSegments)
    ? raw.sourceSegments.filter((n): n is number => typeof n === 'number').slice(0, 20)
    : [];

  const domain: LifeDomain = (LIFE_DOMAINS as readonly string[]).includes(raw.domain ?? '')
    ? (raw.domain as LifeDomain)
    : domainForType(type);

  const personalizedOn = Array.isArray(raw.personalizedOn)
    ? raw.personalizedOn.filter((key): key is string => typeof key === 'string' && key.length > 0).slice(0, 6)
    : [];

  return {
    title: title.slice(0, 140),
    type,
    why: (raw.why ?? '').trim() || whyFor(type, title),
    proposedMethod: (raw.proposedMethod ?? '').trim() || methodFor(type),
    prerequisites,
    missingPrerequisites: [],
    effort,
    impact,
    riskTier: ITEM_TYPE_RISK[type],
    // Scopes are assigned server-side from the item type, never taken from the
    // model — an item can only ever hold the least privilege its type implies.
    scopes: ITEM_TYPE_SCOPES[type],
    requiresBrowser: raw.requiresBrowser === true || type === 'download_file',
    parameters: raw.parameters && typeof raw.parameters === 'object' ? raw.parameters : {},
    sourceSegments,
    duplicateOfItemId: null,
    domain,
    personalizedOn,
  };
}

/** The domain an item type belongs to when the model did not say. */
function domainForType(type: ItemType): LifeDomain {
  switch (type) {
    case 'acquire_media':
    case 'learn_topic':
      return 'learning';
    case 'purchase':
    case 'financial_review':
      return 'money';
    case 'contact_person':
      return 'relationships';
    case 'build_habit':
      return 'health';
    case 'research_topic':
      return 'other';
    default:
      return 'ai_workflow';
  }
}

/** Rule-based path: real extraction, no model required. */
function analyzeOffline(input: AnalysisInput): AnalysisResult {
  const tips = extractCandidateTips(input.mergedText, input.lowConfidence ? 3 : 6);

  if (tips.length === 0) {
    return learningFallback(input);
  }

  const items: DraftItem[] = tips.map((tip) => {
    const type = tip.type;
    return {
      title: titleFromTip(tip.text),
      type,
      why: whyFor(type, tip.text),
      proposedMethod: methodFor(type),
      prerequisites: inferPrerequisites(tip.text),
      missingPrerequisites: [],
      effort: effortFor(type),
      impact: impactFor(type),
      riskTier: ITEM_TYPE_RISK[type],
      scopes: ITEM_TYPE_SCOPES[type],
      requiresBrowser: type === 'download_file',
      parameters: offlineParameters(type, tip.text),
      sourceSegments: tip.segmentOrders,
      duplicateOfItemId: null,
      domain: domainForType(type),
      // The offline path does no personalization and says so by leaving this
      // empty, rather than implying a tailoring it did not perform.
      personalizedOn: [],
    };
  });

  const title = input.postTitle?.trim() || titleFromTip(tips[0]!.text);
  const summary = renderOfflineSummary(input, tips.map((t) => t.text));

  // One route only. Offering a choice of pathways requires knowing enough about
  // someone to say why one suits them, which the rule-based path cannot do.
  const pathways: DraftPathway[] = [
    {
      label: 'Set it all up',
      stance: 'balanced',
      rationale:
        'Every item found in this capture, in the order it appeared. Connect a model to get routes ' +
        'tailored to how you actually work.',
      groundedInFacts: [],
      estimatedMinutes: items.length * 5,
      estimatedCostUsd: 0,
      itemIndexes: items.map((_, index) => index),
      recommended: true,
      ordinal: 0,
    },
  ];

  return {
    title: title.slice(0, 120),
    summaryPlainEnglish: summary,
    technicalSpec: renderTechnicalSpec(input, summary, items, pathways),
    items,
    pathways,
    domains: input.triage?.domains ?? [...new Set(items.map((item) => item.domain))].slice(0, 4),
    proposedFacts: [],
    noActionableItems: false,
    usage: { modelTokens: 0, usd: 0 },
    analyzer: 'offline',
  };
}

/**
 * Parameters for the offline path. The generated content is deliberately a
 * faithful restatement of the source plus setup scaffolding — it never asserts
 * anything the post did not say.
 */
function offlineParameters(type: ItemType, tip: string): Record<string, unknown> {
  // slugify cuts at a word boundary and trims stray hyphens; a raw `.slice(40)`
  // produces names like "create-a-reusable-skill-that-reads-your-".
  const name = slugify(titleFromTip(tip), 40);

  switch (type) {
    case 'create_skill':
      return {
        name: name || 'captured-tip',
        description: titleFromTip(tip),
        body: [
          `# ${titleFromTip(tip)}`,
          '',
          '## What this does',
          '',
          tip,
          '',
          '## How to use it',
          '',
          'Invoke this skill when you want to apply the practice above. The source advice is quoted',
          'verbatim so you can judge it for yourself before relying on it.',
          '',
          '> Extracted automatically from a captured post. Review before use.',
        ].join('\n'),
      };
    case 'set_instruction':
      return { instruction: asInstruction(tip) };
    case 'schedule_task': {
      const cron = inferCron(tip);
      return {
        name: name || 'captured-routine',
        cron,
        timezone: 'UTC',
        description: tip,
      };
    }
    case 'connect_tool': {
      const prerequisites = inferPrerequisites(tip);
      return {
        kind: (prerequisites[0] ?? 'connector').replace(/\s*connector$/, '').replace(/\s+/g, '-'),
        steps: [
          'Open the app’s Settings → Connectors screen.',
          `Add the connector this tip depends on: ${prerequisites[0] ?? 'the referenced tool'}.`,
          'Re-run this item once the connector is configured.',
        ],
      };
    }
    case 'download_file':
      return { url: tip.match(/https?:\/\/\S+/)?.[0] ?? null, filename: `${name || 'resource'}.bin` };
    case 'configure_setting':
      return { setting: titleFromTip(tip), value: 'see steps', steps: [tip] };
    case 'run_command':
      return { command: tip.match(/`([^`]+)`/)?.[1] ?? '', explanation: tip };
    case 'generate_file':
    default:
      return {
        filename: `${name || 'captured-tip'}.md`,
        content: [`# ${titleFromTip(tip)}`, '', tip, '', '> Extracted automatically from a captured post.'].join('\n'),
      };
  }
}

/**
 * Turns "Also add a standing instruction to always keep answers short" into
 * "Always keep answers short".
 *
 * The tip describes the *act of setting* an instruction; what belongs in the
 * instructions file is the instruction itself. Written verbatim, the file ends
 * up telling the assistant to add an instruction.
 */
function asInstruction(tip: string): string {
  // Connectives first. The meta-strip below is anchored at the start of the
  // string, so a leading "And"/"Also" defeats it entirely and the instructions
  // file ends up telling the assistant to *set an instruction* — the exact
  // failure this function exists to prevent.
  const stripped = stripAdviceFraming(tip)
    .replace(
      /^\s*(also\s+)?(add|set|give|create|write|put|include)\s+(a|an|the)?\s*(standing|custom|system|default)?\s*(instruction|prompt|rule|directive)s?\s*(to|that|saying|which says)?\s*/i,
      '',
    )
    .replace(/^\s*(tell|ask)\s+(it|claude|chatgpt|your assistant)\s+to\s+/i, '')
    .replace(/^\s*(in|to)\s+your\s+(settings|preferences|instructions|profile)[,\s]+/i, '')
    .trim()
    .replace(/[.!]+$/, '');

  const instruction = stripped.length >= 12 ? stripped : tip.trim().replace(/[.!]+$/, '');
  return instruction.charAt(0).toUpperCase() + instruction.slice(1);
}

/** Best-effort cron from natural language; defaults to 7am daily. */
function inferCron(text: string): string {
  const lower = text.toLowerCase();
  const timeMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/);
  let hour = 7;
  let minute = 0;
  if (timeMatch) {
    hour = Number(timeMatch[1]) % 12;
    if (timeMatch[3]?.startsWith('p')) hour += 12;
    minute = Number(timeMatch[2] ?? 0);
  } else if (/\bnight|evening\b/.test(lower)) hour = 20;
  else if (/\bafternoon\b/.test(lower)) hour = 14;
  else if (/\bnoon|lunch\b/.test(lower)) hour = 12;

  if (/\bweekly|every week\b/.test(lower)) return `${minute} ${hour} * * 1`;
  if (/\bfriday\b/.test(lower)) return `${minute} ${hour} * * 5`;
  if (/\bmonday\b/.test(lower)) return `${minute} ${hour} * * 1`;
  if (/\bweekday|work ?day\b/.test(lower)) return `${minute} ${hour} * * 1-5`;
  if (/\bhourly|every hour\b/.test(lower)) return `${minute} * * * *`;
  return `${minute} ${hour} * * *`;
}

function renderOfflineSummary(input: AnalysisInput, tips: string[]): string {
  const platform = PLATFORM_LABELS[input.platform];
  const lead =
    tips.length === 1
      ? `This ${platform} post makes one recommendation:`
      : `This ${platform} post makes ${tips.length} recommendations:`;
  const bullets = tips.map((tip) => `• ${tip.length > 220 ? `${tip.slice(0, 217)}…` : tip}`).join('\n');
  const caveat = input.lowConfidence
    ? '\n\nThe text behind this summary was extracted with low confidence, so check it against the original before approving anything.'
    : '';
  return `${lead}\n\n${bullets}\n\nEach one is listed below as a separate item you can approve or skip.${caveat}`;
}

/**
 * A grounded safety net for successfully retrieved content that does not state
 * a direct instruction. The product still returns value, but it does not put
 * invented words in the creator's mouth: the proposed experiment is labelled
 * as the app's application of the source.
 */
function learningFallback(
  input: AnalysisInput,
  modelSummary?: string,
  usage: { modelTokens: number; usd: number } = { modelTokens: 0, usd: 0 },
  analyzer: LlmProviderName = 'offline',
): AnalysisResult {
  const taggedLines = input.mergedText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const excerpts = taggedLines
    .map((line) => line.replace(/^\[\d+\]\s*\([^)]*\)\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 5);
  const sourceSegments = Array.from(
    new Set(
      taggedLines
        .map((line) => Number(line.match(/^\[(\d+)\]/)?.[1]))
        .filter((value) => Number.isFinite(value)),
    ),
  ).slice(0, 20);
  const title = input.postTitle?.trim().slice(0, 120) || titleFromTip(excerpts[0] ?? 'Apply this saved idea');
  const filename = `${slugify(title, 48) || 'saved-idea'}-application-note.md`;
  const domain = input.triage?.domains[0] ?? 'other';
  const personalContext = getUserById(input.userId)?.preferences.personalContext?.trim();
  const sourceBlock = excerpts.map((excerpt) => `> ${excerpt}`).join('\n>\n');
  const content = [
    `# Apply: ${title}`,
    '',
    `Source: ${input.inputKind === 'link' ? input.url : INPUT_KIND_LABELS[input.inputKind]}`,
    '',
    '## What the source actually contains',
    '',
    sourceBlock || '> Review the extracted transcript attached to this capture.',
    '',
    '## Find the delta',
    '',
    '- What here is different from what you already do, believe, or use?',
    '- Where in your real week would that difference matter?',
    '- What evidence would tell you this idea is an improvement rather than just interesting?',
    ...(personalContext
      ? ['', 'Context to use when answering:', '', personalContext]
      : []),
    '',
    '## Smallest useful test',
    '',
    '1. Choose one claim, pattern, or example from the source.',
    '2. Compare it with your current process in one specific situation.',
    '3. Run the smallest reversible test you can complete this week.',
    '4. Record what became faster, clearer, easier, or more reliable.',
    '5. Keep, adapt, or discard it based on that result.',
    '',
    '> The test above is an application proposed by the app; it is not presented as advice stated by the creator.',
  ].join('\n');

  const item: DraftItem = {
    title: 'Test the saved idea in your life',
    type: 'generate_file',
    why: 'The source did not state a clean instruction, but discarding it would lose why you saved it. This note turns it into a small, explicit test without inventing a claim the creator did not make.',
    proposedMethod: `Create ${filename} with the source excerpts, a delta check, and a one-week reversible experiment.`,
    prerequisites: [],
    missingPrerequisites: [],
    effort: 'low',
    impact: 'medium',
    riskTier: ITEM_TYPE_RISK.generate_file,
    scopes: ITEM_TYPE_SCOPES.generate_file,
    requiresBrowser: false,
    parameters: { filename, content },
    sourceSegments,
    duplicateOfItemId: null,
    domain,
    personalizedOn: [],
  };
  const summary = modelSummary
    ? `${modelSummary}\n\nRather than discard the link, the app prepared one grounded application note so you can test whether the idea changes anything in your life or work.`
    : 'This source did not state a clean step-by-step recommendation. Rather than discard it, the app prepared a grounded application note that preserves the source and turns your interest in it into one small test.';

  const pathways: DraftPathway[] = [
    {
      label: 'Test the idea safely',
      stance: 'balanced',
      rationale: 'A small reversible experiment preserves the useful part of the capture without inventing advice.',
      groundedInFacts: [],
      estimatedMinutes: 20,
      estimatedCostUsd: 0,
      itemIndexes: [0],
      recommended: true,
      ordinal: 0,
    },
  ];

  return {
    title,
    summaryPlainEnglish: summary,
    technicalSpec: renderTechnicalSpec(input, summary, [item], pathways),
    items: [item],
    pathways,
    domains: [domain],
    proposedFacts: [],
    noActionableItems: false,
    usage,
    analyzer,
  };
}

/**
 * The 04_spec.md artifact: what Claude would need to do to apply this post's
 * advice in the user's environment (BR-A3).
 */
function renderTechnicalSpec(
  input: AnalysisInput,
  summary: string,
  items: DraftItem[],
  pathways: DraftPathway[],
): string {
  const lines: string[] = [
    `# Technical specification`,
    '',
    `**Source:** ${input.inputKind === 'link' ? input.url : INPUT_KIND_LABELS[input.inputKind]}`,
    input.inputKind === 'link' ? `**Platform:** ${PLATFORM_LABELS[input.platform]}` : '',
    input.author ? `**Author:** ${input.author}` : '',
    `**Extraction confidence:** ${(input.overallConfidence * 100).toFixed(0)}%${input.lowConfidence ? ' — flagged low' : ''}`,
    `**Personalized against:** ${
      input.lifeContext.factCount > 0
        ? `${input.lifeContext.factCount} profile fact${input.lifeContext.factCount === 1 ? '' : 's'}`
        : 'nothing — profile is empty'
    }`,
    '',
    '## What this recommends',
    '',
    summary,
    '',
  ].filter(Boolean);

  if (items.length === 0) {
    lines.push('No implementation path was generated. This result should be treated as an analysis failure and retried.');
    return lines.join('\n');
  }

  if (pathways.length > 0) {
    lines.push('## Routes', '');
    for (const pathway of pathways) {
      lines.push(
        `### ${pathway.label}${pathway.recommended ? ' — recommended' : ''}`,
        '',
        `**Stance:** ${pathway.stance} · **Time:** ~${pathway.estimatedMinutes} min · **Cost:** $${pathway.estimatedCostUsd.toFixed(2)}`,
        '',
        pathway.rationale,
        '',
        `**Covers items:** ${pathway.itemIndexes.map((index) => index + 1).join(', ')}`,
        pathway.groundedInFacts.length > 0
          ? `**Based on what we know about you:** ${pathway.groundedInFacts.join(', ')}`
          : '',
        '',
      );
    }
  }

  lines.push('## Proposed items', '');

  items.forEach((item, index) => {
    lines.push(
      `### ${index + 1}. ${item.title}`,
      '',
      `| Field | Value |`,
      `| --- | --- |`,
      `| Type | \`${item.type}\` |`,
      `| Domain | ${item.domain} |`,
      `| Personalized on | ${item.personalizedOn.length ? item.personalizedOn.join(', ') : '—'} |`,
      `| Effort / Impact | ${item.effort} / ${item.impact} |`,
      `| Risk tier | ${item.riskTier} |`,
      `| Permission scopes | ${item.scopes.map((s) => `\`${s}\``).join(', ')} |`,
      `| Prerequisites | ${item.prerequisites.length ? item.prerequisites.join(', ') : '—'} |`,
      `| Missing prerequisites | ${item.missingPrerequisites.length ? item.missingPrerequisites.join(', ') : 'none'} |`,
      `| Requires browser | ${item.requiresBrowser ? 'yes' : 'no'} |`,
      `| Source segments | ${item.sourceSegments.length ? item.sourceSegments.join(', ') : '—'} |`,
      '',
      `**Why:** ${item.why}`,
      '',
      `**Method:** ${item.proposedMethod}`,
      '',
    );

    const parameters = JSON.stringify(item.parameters, null, 2);
    if (parameters && parameters !== '{}') {
      lines.push('**Parameters:**', '', '```json', parameters, '```', '');
    }
  });

  return lines.join('\n');
}

/**
 * Flags items that repeat something the user already approved from a previous
 * link, so the review UI can offer "already done" instead of a duplicate (BR-A7).
 */
function markDuplicates(userId: string, items: DraftItem[]): void {
  const previous = previouslyApprovedItems(userId);
  if (previous.length === 0) return;

  for (const item of items) {
    const normalized = normalizeTitle(item.title);
    const match = previous.find(
      (candidate) => candidate.type === item.type && similarity(normalizeTitle(candidate.title), normalized) > 0.7,
    );
    if (match) item.duplicateOfItemId = match.itemId;
  }
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a: string, b: string): number {
  const tokensA = new Set(a.split(' ').filter((t) => t.length > 2));
  const tokensB = new Set(b.split(' ').filter((t) => t.length > 2));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let shared = 0;
  for (const token of tokensA) if (tokensB.has(token)) shared++;
  return shared / Math.min(tokensA.size, tokensB.size);
}
