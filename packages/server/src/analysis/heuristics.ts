import type { EffortLevel, ImpactLevel, ItemType } from '@aiapp/shared';

/**
 * Rule-based insight extraction.
 *
 * This is the offline path used when ANTHROPIC_API_KEY is absent, and it is
 * also the safety net when a model call fails. It is deliberately conservative:
 * it only promotes text that actually reads like an instruction, because the
 * one thing the product must never do is invent advice the post did not give
 * (BRD use case 9.4, spec §5.10).
 */

export interface CandidateTip {
  text: string;
  /** 0–1 — how strongly this reads as actionable advice. */
  score: number;
  type: ItemType;
  segmentOrders: number[];
  /** Where this appeared in the source, used to keep the plan in reading order. */
  position: number;
}

/** Sentence openers that signal an instruction rather than commentary. */
const IMPERATIVE_VERBS = [
  'add',
  'ask',
  'automate',
  'build',
  'change',
  'configure',
  'connect',
  'create',
  'define',
  'disable',
  'download',
  'enable',
  'give',
  'install',
  'instruct',
  'keep',
  'let',
  'make',
  'open',
  'paste',
  'pin',
  'point',
  'put',
  'record',
  'replace',
  'run',
  'save',
  'schedule',
  'set',
  'setup',
  'share',
  'start',
  'stop',
  'store',
  'switch',
  'tell',
  'try',
  'turn',
  'type',
  'update',
  'upload',
  'use',
  'write',
];

/** Phrases that introduce a recommendation. */
const ADVICE_MARKERS = [
  'you should',
  'you can',
  'you need to',
  'you have to',
  'make sure',
  'be sure to',
  'the trick is',
  'the secret is',
  'pro tip',
  'protip',
  'what you do is',
  'all you have to do',
  'i recommend',
  'my favorite',
  'the best way',
  'instead of',
  'rather than',
  'this way',
  'so that',
  'if you want',
  'start by',
  'first,',
  'next,',
  'then,',
  'finally,',
  'step 1',
  'step one',
  'the key is',
  'game changer',
  'saves you',
  'never again',
  'stop doing',
];

/**
 * Recurrence and time-of-day phrasing. "Do this every morning" is one of the
 * most common shapes an actionable tip takes, and it often carries none of the
 * other signals — the sentence is a bare imperative with no domain vocabulary.
 */
const RECURRENCE_MARKERS = [
  /\bevery (morning|day|night|week|month|monday|tuesday|wednesday|thursday|friday|hour)\b/i,
  /\beach (morning|day|night|week)\b/i,
  /\b(daily|weekly|nightly|hourly|recurring|automatically)\b/i,
  /\bat \d{1,2}(:\d{2})?\s?(a\.?m\.?|p\.?m\.?)\b/i,
  /\b\d{1,2}\s?(am|pm)\b/i,
];

/** Domain vocabulary — advice about AI tooling is what this product is for. */
const DOMAIN_TERMS = [
  'claude',
  'chatgpt',
  'gpt',
  'gemini',
  'copilot',
  'llm',
  'ai',
  'prompt',
  'system prompt',
  'instruction',
  'context',
  'agent',
  'skill',
  'workflow',
  'automation',
  'connector',
  'mcp',
  'integration',
  'api',
  'model',
  'token',
  'memory',
  'project',
  'artifact',
  'subagent',
  'tool',
  'shortcut',
  'template',
  'routine',
  // Tool names: advice about wiring up an integration is squarely in scope, and
  // the sentence often carries no other domain vocabulary.
  'slack',
  'gmail',
  'github',
  'notion',
  'calendar',
  'inbox',
  'drive',
  'obsidian',
];

/** Ordered most-specific-first: the first pattern that matches wins. */
const TYPE_RULES: { type: ItemType; patterns: RegExp[] }[] = [
  {
    type: 'schedule_task',
    patterns: [
      /\bevery (morning|day|night|week|monday|hour)\b/i,
      // "weekly" must be adverbial. In "drafts your weekly review" it modifies
      // a noun and describes what the thing is, not when it should run — that
      // is a skill, not a schedule.
      /\b(daily|weekly|nightly|hourly|recurring)\b(?!\s+(report|review|update|summary|digest|standup|stand-up|newsletter|plan|planning|meeting|email|note|notes|recap|roundup|round-up|check-?in|retro|sync))/i,
      /\bschedule(d|s)?\b/i,
      /\bat \d{1,2}(:\d{2})?\s?(a\.?m\.?|p\.?m\.?)/i,
      /\bcron\b/i,
      /\bautomatically (each|every)\b/i,
    ],
  },
  {
    type: 'connect_tool',
    patterns: [
      /\bconnect(or|ing)?\b.{0,30}\b(gmail|slack|github|calendar|drive|notion|jira|linear|rally)\b/i,
      /\b(mcp|integration)\b/i,
      /\bhook (it |this )?up\b/i,
      /\bgive (it|claude) access\b/i,
      /\benable the .{0,20}connector\b/i,
    ],
  },
  {
    type: 'download_file',
    patterns: [/\bdownload\b/i, /\binstall\b/i, /\bgrab the (file|template|pack)\b/i, /\blink in (my )?bio\b/i],
  },
  {
    type: 'create_skill',
    patterns: [
      /\b(skill|routine|workflow|recipe|command|macro)\b/i,
      /\breusable\b/i,
      /\bsave (it|this) as\b/i,
      /\bslash command\b/i,
      /\bcustom (gpt|agent|assistant)\b/i,
    ],
  },
  {
    type: 'set_instruction',
    patterns: [
      /\b(system prompt|standing instruction|custom instruction|style guide|persona)\b/i,
      /\btell (it|claude|chatgpt) to always\b/i,
      /\balways (respond|answer|reply|keep|use|start)\b/i,
      /\bnever (respond|answer|reply|use)\b/i,
      /\bin your (settings|preferences|profile|instructions)\b/i,
      /\bmemory\b/i,
    ],
  },
  {
    type: 'generate_file',
    patterns: [
      /\b(template|checklist|cheat ?sheet|starter|boilerplate|snippet|prompt library)\b/i,
      /\bwrite (a|the) (file|doc|document|markdown)\b/i,
      /\bcreate a (file|doc|document|note)\b/i,
    ],
  },
  {
    type: 'configure_setting',
    patterns: [
      /\b(turn|switch) (it )?(on|off)\b/i,
      /\benable\b/i,
      /\bdisable\b/i,
      /\bsetting(s)?\b/i,
      /\btoggle\b/i,
      /\bpreferences?\b/i,
    ],
  },
];

/**
 * Sentences that announce advice rather than being it.
 *
 * "Here's how to make Claude summarize your inbox every morning" is a title, not
 * a step — the actual instructions follow. Left unpenalized it scores highly
 * (imperative-adjacent, domain vocabulary, recurrence wording) and turns the
 * post's own headline into a duplicate item.
 */
const PREAMBLE_PATTERNS = [
  /^\s*(here'?s?( is)?|this is|that'?s)\s+(how|the|what|why|a)\b/i,
  /^\s*(let me|i'?ll|i am going to|i'?m gonna|imma)\s+(show|tell|walk|explain)/i,
  /^\s*(watch|check out|look at)\s+(this|how|what)/i,
  /^\s*(in this|today i'?ll|today we)\b/i,
  /^\s*(the )?(best|craziest|wildest|most useful)\s+\w+\s+(i'?ve (ever )?)?(seen|found|used)/i,
];

/**
 * Connectives and filler creators front-load onto instructions ("Also add…",
 * "Just turn on…", "Number two, create…"). Stripped before the imperative-verb
 * check and before building a title, or a genuine instruction reads as
 * commentary and never clears the scoring bar.
 */
const LEADING_FILLER =
  /^((so|now|then|and|but|ok|okay|alright|also|plus|just|simply|literally|basically|honestly|actually|next|first|firstly|second|secondly|third|thirdly|finally|lastly|additionally|again|oh)[,\s]+|(number|step|tip)\s+(one|two|three|four|five|\d+)[,:.\s]+|\d+[.)]\s*)+/i;

const SEGMENT_TAG = /^\[(\d+)\]\s*\([^)]*\)\s*/;

interface Sentence {
  text: string;
  segmentOrder: number;
  /** Position across the whole document — a caption arrives as one segment, so
   *  segment order alone cannot order sentences within it. */
  position: number;
}

/** Splits annotated merged text back into sentences, keeping segment origins. */
export function splitSentences(mergedText: string): Sentence[] {
  const out: Sentence[] = [];
  for (const line of mergedText.split('\n')) {
    const match = line.match(SEGMENT_TAG);
    const segmentOrder = match?.[1] ? Number(match[1]) : -1;
    const body = line.replace(SEGMENT_TAG, '').replace(/^SLIDE \d+:\s*/i, '').trim();
    if (!body) continue;

    // Split on sentence enders and on the bullet/numbered markers creators use.
    const pieces = body
      .split(/(?<=[.!?])\s+(?=[A-Z0-9])|\s*[•·‣]\s*|\s+(?=\d+[.)]\s+[A-Z])/)
      .map((piece) => piece.trim())
      .filter(Boolean);
    for (const piece of pieces) {
      if (piece.length < 12) continue;
      out.push({ text: piece, segmentOrder, position: out.length });
    }
  }
  return out;
}

function scoreSentence(text: string): number {
  const lower = text.toLowerCase();
  let score = 0;

  const firstWord = lower.replace(LEADING_FILLER, '').split(/\s+/)[0] ?? '';
  if (IMPERATIVE_VERBS.includes(firstWord.replace(/[^a-z]/g, ''))) score += 0.35;

  for (const marker of ADVICE_MARKERS) {
    if (lower.includes(marker)) {
      score += 0.3;
      break;
    }
  }

  if (RECURRENCE_MARKERS.some((pattern) => pattern.test(text))) score += 0.2;

  // Word-boundary matching, not substring: plain `includes('ai')` fires on
  // "email", "explain", "detail" and "said", which quietly promotes commentary.
  const domainHits = DOMAIN_TERMS.filter((term) =>
    new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text),
  ).length;
  score += Math.min(0.3, domainHits * 0.12);

  // Numbered/step framing is a strong signal of an instruction list.
  if (/^\s*(\d+[.)]|step\s+\d)/i.test(text)) score += 0.2;

  // Length sweet spot: long enough to carry an instruction, short enough to be one.
  if (text.length >= 40 && text.length <= 400) score += 0.1;
  if (text.length > 600) score -= 0.2;

  // Discount pure engagement bait and commentary.
  if (/\b(follow me|like and|comment below|subscribe|link in bio|drop a|tag someone|part \d+)\b/i.test(lower)) {
    score -= 0.35;
  }

  // A preamble announces the advice; the advice itself is the next sentence.
  if (PREAMBLE_PATTERNS.some((pattern) => pattern.test(text))) score -= 0.45;
  if (/^(i |we |they |he |she |it was|this is just|honestly|basically nothing)/.test(lower) && score < 0.4) {
    score -= 0.1;
  }
  if (/\?$/.test(text.trim())) score -= 0.15;

  // Rounded before it meets the threshold: the weights are chosen in hundredths,
  // but binary floats make 0.35 + 0.1 come out as 0.44999…, so a sentence that
  // should score exactly at the bar silently falls under it.
  return Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000;
}

export function classifyType(text: string): ItemType {
  for (const rule of TYPE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(text))) return rule.type;
  }
  return 'generate_file';
}

/** Threshold above which a sentence is treated as genuine advice. */
const TIP_THRESHOLD = 0.45;

export function extractCandidateTips(mergedText: string, maxTips = 6): CandidateTip[] {
  const sentences = splitSentences(mergedText);
  const scored = sentences
    .map((sentence) => ({
      text: sentence.text,
      score: scoreSentence(sentence.text),
      segmentOrder: sentence.segmentOrder,
      position: sentence.position,
    }))
    .filter((candidate) => candidate.score >= TIP_THRESHOLD);

  // Merge near-duplicates: the same tip often appears in caption, audio and OCR.
  const merged: CandidateTip[] = [];
  for (const candidate of scored.sort((a, b) => b.score - a.score)) {
    const signature = tokenSet(candidate.text);
    const existing = merged.find((tip) => jaccard(tokenSet(tip.text), signature) > 0.55);
    if (existing) {
      if (!existing.segmentOrders.includes(candidate.segmentOrder)) {
        existing.segmentOrders.push(candidate.segmentOrder);
      }
      // Prefer the longest phrasing — it usually carries the most detail.
      if (candidate.text.length > existing.text.length) existing.text = candidate.text;
      // Keep the earliest position so the merged tip sorts where it first appeared.
      existing.position = Math.min(existing.position, candidate.position);
      continue;
    }
    merged.push({
      text: candidate.text,
      score: candidate.score,
      type: classifyType(candidate.text),
      segmentOrders: candidate.segmentOrder >= 0 ? [candidate.segmentOrder] : [],
      position: candidate.position,
    });
    if (merged.length >= maxTips) break;
  }

  // Selection is by score, but presentation follows the source. A post's advice
  // is usually sequential ("first…, then…, finally…"), and showing step 3 above
  // step 1 because it scored higher makes the plan read as nonsense.
  return merged.sort((a, b) => a.position - b.position);
}

function tokenSet(text: string): Set<string> {
  const STOP = new Set([
    'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'it', 'that', 'this',
    'you', 'your', 'i', 'we', 'be', 'can', 'will', 'with', 'so', 'if', 'at', 'as', 'by', 'do',
  ]);
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2 && !STOP.has(token)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/** Turns a raw tip sentence into a short imperative title. */
export function titleFromTip(text: string): string {
  let title = text
    .replace(LEADING_FILLER, '')
    .replace(
      /^(you should|you can|you need to|you have to|make sure( to| that)?|be sure to|i recommend( that)?|the trick is( to)?|the secret is( to)?|the key is( to)?|what you do is|all you have to do is|pro ?tip:?)\s*/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();

  // Trim to one clause so the review UI stays scannable.
  const clauseEnd = title.search(/[,;:]\s|(?:\s-\s)/);
  if (clauseEnd > 30) title = title.slice(0, clauseEnd);
  if (title.length > 90) {
    const cut = title.slice(0, 90);
    const space = cut.lastIndexOf(' ');
    title = space > 50 ? cut.slice(0, space) : cut;
  }
  title = title.replace(/[.!?]+$/, '').trim();
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : 'Apply this tip';
}

/** Prerequisite names implied by a tip's wording, for BR-A6 flagging. */
export function inferPrerequisites(text: string): string[] {
  const found = new Set<string>();
  const CHECKS: [RegExp, string][] = [
    [/\b(gmail|inbox|email|e-mail)\b/i, 'email connector'],
    [/\b(calendar|meetings?|schedule my day)\b/i, 'calendar connector'],
    [/\b(slack|teams|discord)\b/i, 'chat connector'],
    [/\b(github|gitlab|repo|pull request)\b/i, 'code connector'],
    [/\b(drive|dropbox|files?|folder)\b/i, 'file access'],
    [/\b(notion|obsidian|notes app)\b/i, 'notes connector'],
    [/\b(jira|linear|rally|asana)\b/i, 'project tracker connector'],
    [/\bbrowser\b/i, 'browser automation'],
  ];
  for (const [pattern, prerequisite] of CHECKS) {
    if (pattern.test(text)) found.add(prerequisite);
  }
  return [...found];
}

const EFFORT_BY_TYPE: Record<ItemType, EffortLevel> = {
  set_instruction: 'low',
  configure_setting: 'low',
  generate_file: 'low',
  create_skill: 'low',
  schedule_task: 'low',
  download_file: 'medium',
  connect_tool: 'medium',
  run_command: 'high',
};

const IMPACT_BY_TYPE: Record<ItemType, ImpactLevel> = {
  create_skill: 'high',
  schedule_task: 'high',
  connect_tool: 'high',
  set_instruction: 'medium',
  configure_setting: 'medium',
  generate_file: 'medium',
  download_file: 'medium',
  run_command: 'medium',
};

export function effortFor(type: ItemType): EffortLevel {
  return EFFORT_BY_TYPE[type];
}

export function impactFor(type: ItemType): ImpactLevel {
  return IMPACT_BY_TYPE[type];
}

/** Plain-language description of what the engine will do for an item type. */
export function methodFor(type: ItemType): string {
  switch (type) {
    case 'create_skill':
      return 'Write a reusable skill definition into your AI Enhancement App folder that you can drop into Claude Code or your assistant.';
    case 'set_instruction':
      return 'Append a standing instruction to your instructions file so it applies to every future conversation.';
    case 'schedule_task':
      return 'Register a recurring task with the scheduler so it runs on its own from now on.';
    case 'connect_tool':
      return 'Record the connector requirement and prepare the setup steps; the connection itself needs your sign-in.';
    case 'download_file':
      return 'Fetch the referenced file into this link’s artifacts folder, using the browser agent when there is no direct link.';
    case 'generate_file':
      return 'Generate the described file and save it into this link’s artifacts folder.';
    case 'configure_setting':
      return 'Write the setting change into your configuration notes with exact steps to apply it.';
    case 'run_command':
      return 'Prepare the command with an explanation; running it needs your explicit confirmation.';
  }
}

/** Why-it-helps sentence when the model is not available to write one. */
export function whyFor(type: ItemType, tip: string): string {
  const subject = tip.length > 120 ? `${tip.slice(0, 117)}…` : tip;
  switch (type) {
    case 'create_skill':
      return `The post recommends this as a repeatable move, so packaging it as a skill means you get it every time instead of remembering to do it. Source: “${subject}”`;
    case 'set_instruction':
      return `This changes how your assistant behaves by default, so setting it once applies it to every conversation. Source: “${subject}”`;
    case 'schedule_task':
      return `The advice only pays off if it happens on a rhythm, which is exactly what a scheduled task guarantees. Source: “${subject}”`;
    case 'connect_tool':
      return `The tip depends on your assistant being able to reach this tool, so the connection is the unlock. Source: “${subject}”`;
    case 'download_file':
      return `The post points at a resource you would otherwise have to go find yourself. Source: “${subject}”`;
    case 'generate_file':
      return `Having the artifact written out means the advice is usable immediately rather than being something to set up later. Source: “${subject}”`;
    case 'configure_setting':
      return `A one-time setting change that the post says materially improves results. Source: “${subject}”`;
    case 'run_command':
      return `The post describes a command-line step; preparing it keeps the work reproducible. Source: “${subject}”`;
  }
}
