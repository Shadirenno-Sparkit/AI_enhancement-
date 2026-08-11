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
  // Life-domain openers. Advice about what to read, buy, cancel or practise is
  // as much an instruction as advice about a system prompt.
  'block',
  'book',
  'buy',
  'call',
  'cancel',
  'check',
  'email',
  'follow',
  'get',
  'join',
  'learn',
  'listen',
  'message',
  'order',
  'practice',
  'practise',
  'read',
  'reach',
  'review',
  'subscribe',
  'swap',
  'track',
  'unsubscribe',
  'walk',
  'watch',
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
    // An explicit "create a skill" outranks the recurrence wording that often
    // sits in the same sentence — "create a skill that runs every morning"
    // describes a skill, and the schedule is a property of it.
    type: 'create_skill',
    patterns: [/\bcreate\s+(a|an)?\s*(reusable|custom|new)?\s*(skill|command|macro)\b/i],
  },
  {
    type: 'acquire_media',
    patterns: [
      /\b(audiobook|ebook|e-book|paperback|hardcover)\b/i,
      /\bread\s+(the\s+)?(book|"|“|')/i,
      /\b(book|course|newsletter|podcast)\b.{0,24}\bby\s+[A-Z]/,
      /\b(pick up|grab|get)\s+(a\s+)?copy\b/i,
      /\b(enrol|enroll|sign up for)\b.{0,20}\bcourse\b/i,
    ],
  },
  {
    type: 'financial_review',
    patterns: [
      /\b(cancel|unsubscribe from)\b.{0,30}\b(subscription|plan|membership|service)/i,
      /\b(interest rate|apy|apr|annual fee|late fee|overdraft)\b/i,
      /\b(refinanc|renegotiat)\w*\b/i,
      /\b(switch|move)\b.{0,24}\b(bank|account|provider|plan)\b/i,
      /\bsubscription\b.{0,40}\b(unused|not (used|opened)|haven'?t (used|opened))/i,
    ],
  },
  {
    type: 'contact_person',
    patterns: [
      /\breach out to\b/i,
      /\b(email|message|dm|call|text)\s+(your|the|him|her|them|someone)\b/i,
      /\b(ask|get)\b.{0,20}\b(for an? )?(intro|introduction|referral)\b/i,
      /\bcatch up with\b/i,
    ],
  },
  {
    type: 'build_habit',
    patterns: [
      /\bhabit\b/i,
      /\b(streak|consistency)\b/i,
      /\bevery (morning|day|night) (for|until)\b/i,
      /\b(stack|attach)\b.{0,24}\bhabit\b/i,
    ],
  },
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

/**
 * Reported speech, stripped before the imperative check.
 *
 * Dictated and overheard captures almost always arrive as "he said you should
 * create a…" or "someone recommended setting up a…". Without this the advice
 * is invisible to the imperative test, and any title generated from it leads
 * with the messenger instead of the message.
 */
const REPORTED_SPEECH =
  /^\s*((the\s+)?(guy|girl|woman|man|person|someone|somebody|they|he|she|a friend|my friend|this (guy|girl|woman|man|person)|everyone|people)\b[^,.]{0,60}?\s+(said|says|told me|recommended|recommends|suggested|suggests|mentioned|mentions|swears by)\s*(that\s+)?|(it|this)\s+(is|was)\s+(said|suggested|recommended)\s+(that\s+)?)/i;

/**
 * Second-person framing around an instruction: "you should X" carries the same
 * advice as "X", and stripping it lets the imperative test see the verb.
 */
const ADVICE_FRAMING =
  /^\s*(you\s+(should|can|could|need to|have to|might want to|ought to|really should)|it('s| is)\s+worth|worth|try(ing)?\s+to|make sure (to|you)|the (trick|move|idea) is to|consider)\s+/i;

/**
 * Candidate base forms for a word, so the imperative list matches inflections.
 *
 * Advice arrives in whatever form the speaker used — "cancelling", "setting up",
 * "reads" — while the verb list holds bare stems. Without this, "Also worth
 * cancelling that subscription" fails the imperative test on a spelling
 * difference and the advice is silently dropped.
 */
export function verbForms(word: string): string[] {
  const base = word.replace(/[^a-z]/g, '');
  if (!base) return [];

  const forms = new Set<string>([base]);
  const add = (candidate: string): void => {
    if (candidate.length >= 2) forms.add(candidate);
  };

  if (base.endsWith('ing')) {
    const stem = base.slice(0, -3);
    add(stem);
    add(`${stem}e`);
    // "cancelling" → "cancell" → "cancel"; "setting" → "sett" → "set".
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) add(stem.slice(0, -1));
  }
  if (base.endsWith('ed')) {
    const stem = base.slice(0, -2);
    add(stem);
    add(`${stem}e`);
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) add(stem.slice(0, -1));
  }
  if (base.endsWith('s') && !base.endsWith('ss')) add(base.slice(0, -1));

  return [...forms];
}

/** Strips messenger and framing so what remains is the advice itself. */
export function stripAdviceFraming(text: string): string {
  let result = text.trim();
  // Applied repeatedly because the forms nest: "He said you should also just…".
  for (let pass = 0; pass < 4; pass++) {
    const before = result;
    result = result.replace(REPORTED_SPEECH, '').replace(LEADING_FILLER, '').replace(ADVICE_FRAMING, '');
    if (result === before) break;
  }
  return result.trim() || text.trim();
}

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

  // Reported speech and "you should" framing are stripped first, so advice
  // relayed second-hand scores the same as advice stated directly — the
  // difference is who said it, not whether it is actionable.
  const firstWord = stripAdviceFraming(lower).split(/\s+/)[0] ?? '';
  if (verbForms(firstWord).some((form) => IMPERATIVE_VERBS.includes(form))) score += 0.35;

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
  let title = stripAdviceFraming(text)
    .replace(
      /^(i recommend( that)?|the trick is( to)?|the secret is( to)?|the key is( to)?|what you do is|all you have to do is|pro ?tip:?)\s*/i,
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
  // Life-domain items. Effort here is the user's, not the engine's: preparing
  // an order is trivial for us and a two-minute decision for them, whereas
  // learning a topic is hours of their time however little we spend.
  research_topic: 'low',
  acquire_media: 'low',
  purchase: 'low',
  financial_review: 'medium',
  contact_person: 'medium',
  build_habit: 'medium',
  automation_workflow: 'medium',
  create_project: 'medium',
  learn_topic: 'high',
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
  build_habit: 'high',
  learn_topic: 'high',
  create_project: 'high',
  automation_workflow: 'high',
  financial_review: 'high',
  acquire_media: 'medium',
  contact_person: 'medium',
  purchase: 'medium',
  research_topic: 'low',
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
    case 'acquire_media':
      return 'Prepare the order in the format you actually consume, with the link ready — you place it.';
    case 'purchase':
      return 'Write up what to buy, what it costs and what to check first. Nothing is bought for you.';
    case 'build_habit':
      return 'Write the habit down with its trigger and cadence, and register the reminder that keeps it alive.';
    case 'learn_topic':
      return 'Lay out a study sequence with checkpoints so the topic has a route through it rather than a pile of links.';
    case 'contact_person':
      return 'Draft the message and save it for you to review. The app never sends anything on your behalf.';
    case 'research_topic':
      return 'Frame the question, list where to look, and note what the answer would let you decide.';
    case 'create_project':
      return 'Set up a project folder with its own instructions and skills, ready to open in Claude.';
    case 'automation_workflow':
      return 'Generate an importable n8n workflow for the automation, with each step wired up.';
    case 'financial_review':
      return 'Write down exactly what to check and the questions to ask. No account is touched.';
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
    case 'acquire_media':
      return `Getting hold of the thing is the step everything else waits on. Source: “${subject}”`;
    case 'purchase':
      return `This names something worth owning; having the decision written down stops it becoming an impulse buy. Source: “${subject}”`;
    case 'build_habit':
      return `The benefit here comes from repetition, so it needs a trigger and a cadence rather than good intentions. Source: “${subject}”`;
    case 'learn_topic':
      return `This is a subject to work through rather than a tip to apply, so it gets a sequence. Source: “${subject}”`;
    case 'contact_person':
      return `Acting on this means talking to someone, and the draft is the part that usually stops people. Source: “${subject}”`;
    case 'research_topic':
      return `There is a decision here you cannot make yet without finding something out first. Source: “${subject}”`;
    case 'create_project':
      return `This is big enough to deserve its own workspace rather than living inside another conversation. Source: “${subject}”`;
    case 'automation_workflow':
      return `The steps described are mechanical and repeat, which is exactly what an automation is for. Source: “${subject}”`;
    case 'financial_review':
      return `Money advice is only worth anything once you check it against your own numbers. Source: “${subject}”`;
  }
}
