import type { LifeDomain, TriageResult, TriageVerdict } from '@aiapp/shared';
import { LIFE_DOMAINS } from '@aiapp/shared';
import { completeJson, llm } from '../providers/llm.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('triage');

/**
 * Phase A — triage (spec §4.4a).
 *
 * The economics of this product only work if reading something is cheap and
 * planning it is rare. Someone who captures thirty things on a commute should
 * pay for thirty short classifications and two or three deep plans, not thirty
 * deep plans.
 *
 * Triage answers three questions as cheaply as possible:
 *   1. Is there anything actionable here at all?
 *   2. Which areas of life does it touch?
 *   3. Is a full plan likely to be worth the spend?
 *
 * It runs on the fast model when one is configured and on pure heuristics
 * otherwise, and it never produces items — only a verdict. The expensive
 * analyzer is gated behind it.
 */

const SYSTEM_PROMPT = `You triage things a person captured from their day — a link, a note they typed, something they dictated, a photo of a page.

Decide, quickly and cheaply, whether it is worth building a full action plan for.

Return ONLY JSON:
{
  "verdict": "actionable" | "reference_only" | "no_action",
  "domains": ["learning"],
  "valueScore": 0.0,
  "headline": "one plain sentence naming what this is and what it could lead to",
  "estimatedItems": 2
}

verdict:
  actionable      the person could plausibly DO something concrete because of this
  reference_only  worth keeping and finding later, but there is no action to take
  no_action       entertainment, engagement bait, or an ad with nothing behind it

domains (choose all that genuinely apply, most significant first):
  ai_workflow learning money health career home relationships travel other

valueScore is 0–1: how much a full personalized plan would be worth to this person.
  0.0–0.3  trivial, already obvious, or barely relevant
  0.4–0.6  useful but small
  0.7–1.0  genuinely changes something about how they work or live

Be strict. Most social media content scores low, and saying so is the correct
answer — it is what makes the expensive pass affordable for the things that matter.`;

interface TriageModelResponse {
  verdict?: string;
  domains?: unknown;
  valueScore?: number;
  headline?: string;
  estimatedItems?: number;
}

export interface TriageInput {
  text: string;
  /** Compact life-context brief, so triage can judge relevance to this person. */
  contextBrief?: string;
  sourceLabel: string;
}

export async function triage(input: TriageInput): Promise<TriageResult> {
  if (!input.text.trim()) {
    return {
      verdict: 'no_action',
      domains: [],
      valueScore: 0,
      headline: 'Nothing could be read from this capture.',
      estimatedItems: 0,
      usage: { modelTokens: 0, usd: 0 },
      engine: llm().live ? 'claude' : 'offline',
    };
  }

  const modelResult = llm().live ? await triageWithModel(input) : null;
  return modelResult ?? triageOffline(input);
}

async function triageWithModel(input: TriageInput): Promise<TriageResult | null> {
  const contextBlock = input.contextBrief
    ? `\n\n--- ABOUT THIS PERSON ---\n${input.contextBrief}\n--- END ---\n` +
      'Judge relevance against the person above, not a generic reader.'
    : '';

  const response = await completeJson<TriageModelResponse>({
    // The fast/cheap model: this call runs on everything captured, so its cost
    // per call is the number that has to stay small.
    fast: true,
    system: SYSTEM_PROMPT,
    prompt:
      `Source: ${input.sourceLabel}${contextBlock}\n\n--- CAPTURED CONTENT ---\n` +
      // Triage reads a prefix, not the whole thing. A verdict does not improve
      // enough past a few thousand characters to justify what the tail costs.
      `${input.text.slice(0, 4000)}\n--- END ---`,
    maxTokens: 400,
  });

  if (!response) {
    log.debug('triage model unavailable — using heuristics');
    return null;
  }

  const body = response.value;
  const verdict: TriageVerdict = (['actionable', 'reference_only', 'no_action'] as const).includes(
    body.verdict as TriageVerdict,
  )
    ? (body.verdict as TriageVerdict)
    : 'reference_only';

  const domains = Array.isArray(body.domains)
    ? (body.domains.filter(
        (domain): domain is LifeDomain => (LIFE_DOMAINS as readonly string[]).includes(domain as string),
      ) as LifeDomain[]).slice(0, 4)
    : [];

  const rawScore = typeof body.valueScore === 'number' ? body.valueScore : 0.5;

  return {
    verdict,
    domains: domains.length > 0 ? domains : ['other'],
    // A `no_action` verdict cannot carry a high score; the two disagreeing would
    // let a low-value item through the auto-plan gate on the score alone.
    valueScore: verdict === 'no_action' ? 0 : Math.max(0, Math.min(1, rawScore)),
    headline: (body.headline ?? '').trim().slice(0, 240) || 'Captured.',
    estimatedItems: Math.max(0, Math.min(12, Math.round(body.estimatedItems ?? 0))),
    usage: {
      modelTokens: response.usage.inputTokens + response.usage.outputTokens,
      usd: response.usage.usd,
    },
    engine: 'claude',
  };
}

// ─── Heuristic triage ────────────────────────────────────────────────────────

/**
 * Domain vocabulary. Deliberately concrete nouns rather than abstract topic
 * words: "audiobook" is evidence, "growth" is not.
 */
const DOMAIN_SIGNALS: Record<LifeDomain, RegExp[]> = {
  ai_workflow: [
    /\b(claude|chatgpt|gpt|llm|prompt|ai agent|automation|workflow|skill|mcp|copilot|assistant)\b/i,
    /\b(n8n|zapier|make\.com|integromat)\b/i,
  ],
  learning: [
    /\b(book|audiobook|read|course|tutorial|lecture|study|learn|certification|newsletter|podcast)\b/i,
    /\b(author|chapter|curriculum|syllabus)\b/i,
  ],
  money: [
    /\b(budget|invest|savings?|interest rate|apy|apr|credit card|mortgage|refinance|subscription|cancel|refund)\b/i,
    /\b(bank|401k|ira|roth|tax|deduction|cashback|fee)\b/i,
  ],
  health: [
    /\b(sleep|workout|exercise|nutrition|diet|protein|calorie|doctor|therapy|meditation|stretch|running)\b/i,
    /\b(steps|hydration|supplement|vitamin)\b/i,
  ],
  career: [
    /\b(resume|cv|interview|promotion|salary|negotiat|linkedin|portfolio|networking|job|recruiter)\b/i,
    /\b(manager|performance review|career)\b/i,
  ],
  home: [
    /\b(kitchen|clean|declutter|grocery|meal prep|laundry|repair|garden|storage|renovat)\b/i,
    /\b(family|kids?|children|household|chore)\b/i,
  ],
  relationships: [
    /\b(friend|reach out|catch up|reconnect|introduction|intro to|mentor|coffee chat)\b/i,
    /\b(partner|spouse|relationship|conversation)\b/i,
  ],
  travel: [/\b(flight|hotel|airbnb|itinerary|trip|travel|visa|passport|packing|lounge|miles|points)\b/i],
  other: [],
};

/** Phrases that mean "this is content, not advice". */
const ENTERTAINMENT = [
  /\bpov\b/i,
  /\bfollow for more\b/i,
  /\blink in bio\b/i,
  /\bcomment below\b/i,
  /\bwho else\b/i,
  /\bthis is so me\b/i,
  /\bnah that never happens\b/i,
  /😂|🤣|💀/,
];

/** Verb shapes that mean "there is something to do here". */
const ACTION_SIGNALS = [
  /\b(you (should|can|could|need to)|try|start|stop|set up|create|schedule|install|enable|turn on|add|switch to|replace|book|order|cancel|automate)\b/i,
  /\b(step \d|first,|then,|finally,)\b/i,
  /\b(here('s| is) how|the trick is|what works)\b/i,
];

export function triageOffline(input: TriageInput): TriageResult {
  const text = input.text;
  const lower = text.toLowerCase();

  const domains = (Object.keys(DOMAIN_SIGNALS) as LifeDomain[])
    .map((domain) => ({
      domain,
      hits: DOMAIN_SIGNALS[domain].reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0),
    }))
    .filter((entry) => entry.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 3)
    .map((entry) => entry.domain);

  const entertainmentHits = ENTERTAINMENT.filter((pattern) => pattern.test(text)).length;
  const actionHits = ACTION_SIGNALS.filter((pattern) => pattern.test(text)).length;

  // Substance proxy: very short captures rarely carry a plan worth building.
  const words = lower.split(/\s+/).filter(Boolean).length;
  const lengthScore = Math.min(1, words / 60);

  let score = 0;
  score += Math.min(0.45, actionHits * 0.18);
  score += Math.min(0.25, domains.length * 0.12);
  score += lengthScore * 0.3;
  score -= entertainmentHits * 0.25;
  score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));

  const verdict: TriageVerdict =
    entertainmentHits > 0 && actionHits === 0
      ? 'no_action'
      : actionHits > 0 && score >= 0.35
        ? 'actionable'
        : score >= 0.2
          ? 'reference_only'
          : 'no_action';

  return {
    verdict,
    domains: domains.length > 0 ? domains : ['other'],
    valueScore: verdict === 'no_action' ? 0 : score,
    headline: headlineFor(verdict, domains, input.sourceLabel),
    estimatedItems: verdict === 'actionable' ? Math.max(1, Math.min(5, actionHits + 1)) : 0,
    usage: { modelTokens: 0, usd: 0 },
    engine: 'offline',
  };
}

function headlineFor(verdict: TriageVerdict, domains: LifeDomain[], sourceLabel: string): string {
  if (verdict === 'no_action') {
    return `This ${sourceLabel.toLowerCase()} reads as entertainment — nothing to act on.`;
  }
  const area = domains[0] ? domains[0].replace(/_/g, ' ') : 'general';
  if (verdict === 'reference_only') {
    return `Worth keeping as ${area} reference, but there is no clear action in it.`;
  }
  return `Looks like practical ${area} advice you could act on.`;
}

/**
 * The gate between phase A and phase B.
 *
 * Returning false does not discard the capture — it parks it in AWAITING_PLAN
 * with its headline, so the user can spend the deep call themselves from the
 * inbox whenever they judge it worth it.
 */
export function shouldAutoPlan(result: TriageResult, threshold: number): boolean {
  if (result.verdict === 'no_action') return false;
  return result.valueScore >= threshold;
}
