import type {
  EffortLevel,
  ImpactLevel,
  ItemType,
  Platform,
  SpecItem,
} from '@aiapp/shared';
import {
  EFFORT_LEVELS,
  IMPACT_LEVELS,
  ITEM_TYPES,
  ITEM_TYPE_RISK,
  ITEM_TYPE_SCOPES,
  PLATFORM_LABELS,
  slugify,
} from '@aiapp/shared';
import { findMissingPrerequisites } from '../repo/connectors.js';
import { previouslyApprovedItems } from '../repo/specs.js';
import { completeJson, llm, type LlmProviderName } from '../providers/llm.js';
import { createLogger } from '../util/logger.js';
import {
  effortFor,
  extractCandidateTips,
  impactFor,
  inferPrerequisites,
  methodFor,
  titleFromTip,
  whyFor,
} from './heuristics.js';

const log = createLogger('analysis');

export type DraftItem = Omit<SpecItem, 'itemId' | 'specId' | 'ordinal'>;

export interface AnalysisResult {
  title: string;
  summaryPlainEnglish: string;
  technicalSpec: string;
  items: DraftItem[];
  noActionableItems: boolean;
  usage: { modelTokens: number; usd: number };
  /** Which analyzer produced the result — shown in the UI for transparency. */
  analyzer: LlmProviderName;
}

export interface AnalysisInput {
  userId: string;
  mergedText: string;
  platform: Platform;
  url: string;
  postTitle?: string | null;
  author?: string | null;
  lowConfidence: boolean;
  overallConfidence: number;
}

const SYSTEM_PROMPT = `You analyze short-form social media content about AI tools and turn it into an implementable plan.

You are given the merged text of one post. Each line is tagged with its index and where it came from, e.g.
  [3] (author captions @00:12) Set a standing instruction to keep answers short.
Sources ranked by reliability: author captions > post caption > on-screen text > speech-to-text > page text.

Your job:
1. Enumerate every DISTINCT tip, trick, recommendation or hack the post actually conveys.
2. Write a plain-English summary of what the post is telling the reader to do and why it is useful.
3. Turn the advice into discrete, independently approvable implementation items.

Hard rules:
- Ground everything in the supplied text. Never invent advice that is not there.
- If the content carries no actionable AI advice (pure entertainment, a product ad, engagement bait),
  return an empty items array and say so plainly in the summary. This is a correct and expected outcome.
- Do not split one idea into several items to pad the list, and do not merge genuinely separate ideas.
- Each item must be something that can be carried out inside the user's own AI environment:
  creating a reusable skill, setting a standing instruction, scheduling a routine, wiring a connector,
  generating a file, downloading a referenced resource, or changing a setting.
- Speech-to-text and OCR make mistakes. If a line is garbled, interpret it charitably or leave it out;
  never build an item on text you cannot read.

Item types (choose the most specific that fits):
  create_skill      a reusable routine/skill/command the user can invoke again
  set_instruction   a standing instruction or system-prompt change
  schedule_task     recurring or deferred work ("every morning", "each Friday")
  connect_tool      wiring up a connector/integration the tip depends on
  download_file     fetching a resource the post points at
  generate_file     producing a template, checklist, prompt library or starter file
  configure_setting a one-time setting or toggle change
  run_command       a command-line step (use sparingly; highest friction)

Return ONLY JSON matching this shape:
{
  "title": "short title for this post, max 8 words",
  "summary": "2-4 sentences, plain English, second person",
  "noActionableItems": false,
  "items": [
    {
      "title": "imperative, max 12 words",
      "type": "create_skill",
      "why": "one or two sentences on the benefit, referencing what the post said",
      "proposedMethod": "concretely what should be done to implement it",
      "prerequisites": ["email connector"],
      "effort": "low",
      "impact": "high",
      "requiresBrowser": false,
      "sourceSegments": [3, 7],
      "parameters": { "name": "morning-inbox-summary", "body": "..." }
    }
  ]
}

The "parameters" object is what the implementation engine consumes. Populate it richly:
  create_skill      { "name": kebab-case, "description": string, "body": full markdown of the skill }
  set_instruction   { "instruction": the exact sentence to add }
  schedule_task     { "name": string, "cron": 5-field cron, "timezone": IANA zone, "description": string }
  connect_tool      { "kind": "gmail"|"slack"|"github"|..., "steps": [string] }
  generate_file     { "filename": "name.md", "content": full file content }
  download_file     { "url": string or null, "filename": string }
  configure_setting { "setting": string, "value": string, "steps": [string] }
  run_command       { "command": string, "explanation": string }
Write real, usable content in these fields — a skill body or file content should be complete enough to use as-is.`;

interface ModelResponse {
  title?: string;
  summary?: string;
  noActionableItems?: boolean;
  items?: {
    title?: string;
    type?: string;
    why?: string;
    proposedMethod?: string;
    prerequisites?: unknown;
    effort?: string;
    impact?: string;
    requiresBrowser?: boolean;
    sourceSegments?: unknown;
    parameters?: Record<string, unknown>;
  }[];
}

/**
 * Insight Extractor + Spec Generator + Feature Decomposer (spec §4.4).
 *
 * Uses Claude when a key is configured, and falls back to the rule-based
 * extractor otherwise — or when the model call fails or returns nonsense — so
 * the pipeline always reaches SPEC_READY with grounded output.
 */
export async function analyze(input: AnalysisInput): Promise<AnalysisResult> {
  if (!input.mergedText.trim()) {
    return emptyResult(input, 'Nothing could be extracted from this link, so there is nothing to act on.');
  }

  const modelResult = llm().live ? await analyzeWithModel(input) : null;
  const result = modelResult ?? analyzeOffline(input);

  // Prerequisite gap check runs on both paths: only the server knows which
  // connectors this user actually has (BR-A6).
  for (const item of result.items) {
    item.missingPrerequisites = findMissingPrerequisites(input.userId, item.prerequisites);
  }
  markDuplicates(input.userId, result.items);

  return result;
}

async function analyzeWithModel(input: AnalysisInput): Promise<AnalysisResult | null> {
  const confidenceNote = input.lowConfidence
    ? `\n\nNOTE: this extraction is low confidence (${input.overallConfidence.toFixed(2)}). Be conservative — prefer fewer, well-supported items over speculative ones.`
    : '';

  const response = await completeJson<ModelResponse>({
    system: SYSTEM_PROMPT,
    prompt:
      `Platform: ${PLATFORM_LABELS[input.platform]}\n` +
      `URL: ${input.url}\n` +
      (input.postTitle ? `Post title: ${input.postTitle}\n` : '') +
      (input.author ? `Author: ${input.author}\n` : '') +
      `\n--- POST CONTENT ---\n${input.mergedText.slice(0, 60_000)}\n--- END ---${confidenceNote}`,
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

  return {
    title: (body.title ?? input.postTitle ?? 'Captured post').trim().slice(0, 120),
    summaryPlainEnglish: summary,
    technicalSpec: renderTechnicalSpec(input, summary, items),
    items,
    noActionableItems: body.noActionableItems === true || items.length === 0,
    usage: {
      modelTokens: response.usage.inputTokens + response.usage.outputTokens,
      usd: response.usage.usd,
    },
    analyzer: llm().name,
  };
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
  };
}

/** Rule-based path: real extraction, no model required. */
function analyzeOffline(input: AnalysisInput): AnalysisResult {
  const tips = extractCandidateTips(input.mergedText, input.lowConfidence ? 3 : 6);

  if (tips.length === 0) {
    return emptyResult(
      input,
      input.lowConfidence
        ? 'The available extraction was incomplete, so no reliable actionable items could be proposed. ' +
          'The advice may be in the video audio or on-screen text; configure media extraction and re-run this link.'
        : 'No actionable AI advice was found in this post. The extracted content reads as commentary or ' +
          'entertainment rather than a tip you could set up, so nothing was proposed.',
    );
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
    };
  });

  const title = input.postTitle?.trim() || titleFromTip(tips[0]!.text);
  const summary = renderOfflineSummary(input, tips.map((t) => t.text));

  return {
    title: title.slice(0, 120),
    summaryPlainEnglish: summary,
    technicalSpec: renderTechnicalSpec(input, summary, items),
    items,
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
  const stripped = tip
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

function emptyResult(input: AnalysisInput, summary: string): AnalysisResult {
  return {
    title: input.postTitle?.trim().slice(0, 120) || `${PLATFORM_LABELS[input.platform]} post`,
    summaryPlainEnglish: summary,
    technicalSpec: renderTechnicalSpec(input, summary, []),
    items: [],
    noActionableItems: true,
    usage: { modelTokens: 0, usd: 0 },
    analyzer: llm().name,
  };
}

/**
 * The 04_spec.md artifact: what Claude would need to do to apply this post's
 * advice in the user's environment (BR-A3).
 */
function renderTechnicalSpec(input: AnalysisInput, summary: string, items: DraftItem[]): string {
  const lines: string[] = [
    `# Technical specification`,
    '',
    `**Source:** ${input.url}`,
    `**Platform:** ${PLATFORM_LABELS[input.platform]}`,
    input.author ? `**Author:** ${input.author}` : '',
    `**Extraction confidence:** ${(input.overallConfidence * 100).toFixed(0)}%${input.lowConfidence ? ' — flagged low' : ''}`,
    '',
    '## What the post recommends',
    '',
    summary,
    '',
    '## Proposed items',
    '',
  ].filter(Boolean);

  if (items.length === 0) {
    lines.push('No actionable items were identified for this link. Nothing will be implemented.');
    return lines.join('\n');
  }

  items.forEach((item, index) => {
    lines.push(
      `### ${index + 1}. ${item.title}`,
      '',
      `| Field | Value |`,
      `| --- | --- |`,
      `| Type | \`${item.type}\` |`,
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
