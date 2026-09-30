/**
 * Canonical data model for the AI Enhancement App.
 *
 * These shapes mirror Technical Specification §7 (Data Model & Schemas) and are
 * the single source of truth shared by the API server, the PWA and the desktop
 * bridge. Anything persisted or sent over the wire is described here.
 */

// ─── Platforms & capture ─────────────────────────────────────────────────────

/** Platforms the resolver classifies. Spec §6.3 coverage matrix. */
export const PLATFORMS = [
  'youtube',
  'instagram',
  'tiktok',
  'x',
  'linkedin',
  'facebook',
  'other',
] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Platforms that can hold user-specific/private content behind a login. */
export const SOCIAL_PLATFORMS = ['youtube', 'instagram', 'tiktok', 'x', 'linkedin', 'facebook'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

/** How a link entered the system. BR-C1 / BR-C2 / BR-C3. */
export const CAPTURE_SOURCES = ['share_target', 'share_extension', 'paste', 'api', 'import'] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

/**
 * What kind of thing the user captured.
 *
 * The product premise is that anything you *experience* is a valid input — a
 * link you were sent, a thought you typed, something you overheard and dictated,
 * a photo of a flyer. Only `link` needs the fetch/extract waterfall; the others
 * arrive carrying their own content.
 */
export const INPUT_KINDS = ['link', 'text', 'voice', 'image', 'email'] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

export const INPUT_KIND_LABELS: Record<InputKind, string> = {
  link: 'Link',
  text: 'Note',
  voice: 'Voice note',
  image: 'Photo',
  email: 'Email',
};

// ─── Job lifecycle ───────────────────────────────────────────────────────────

/**
 * Orchestrator states. Spec §5.4.
 * The happy path runs top to bottom; the terminal set is DONE | PARTIAL |
 * NEEDS_INPUT | FAILED | NO_ACTION.
 */
export const JOB_STATES = [
  'RECEIVED',
  'RESOLVED',
  'FETCHED',
  'TRANSCRIBED',
  'NORMALIZED',
  'TRIAGED',
  'AWAITING_PLAN',
  'ANALYZED',
  'SPEC_READY',
  'AWAITING_DECISION',
  'IMPLEMENTING',
  'DONE',
  'PARTIAL',
  'NEEDS_INPUT',
  'NO_ACTION',
  'FAILED',
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_JOB_STATES: readonly JobState[] = [
  'DONE',
  'PARTIAL',
  'NEEDS_INPUT',
  'NO_ACTION',
  'FAILED',
];

/**
 * A job parked here has been triaged and is worth planning, but the deep
 * (expensive) analysis has not been spent yet — it waits for the user to ask.
 * This is the resting state that keeps a day of casual capture cheap.
 */
export const AWAITING_PLAN_STATE: JobState = 'AWAITING_PLAN';

/** Ordering used to prevent the state machine from moving backwards. */
export const JOB_STATE_ORDER: Record<JobState, number> = {
  RECEIVED: 0,
  RESOLVED: 1,
  FETCHED: 2,
  TRANSCRIBED: 3,
  NORMALIZED: 4,
  TRIAGED: 5,
  AWAITING_PLAN: 6,
  ANALYZED: 7,
  SPEC_READY: 8,
  AWAITING_DECISION: 9,
  IMPLEMENTING: 10,
  DONE: 11,
  PARTIAL: 11,
  NEEDS_INPUT: 11,
  NO_ACTION: 11,
  FAILED: 11,
};

export interface JobCost {
  asrSeconds: number;
  modelTokens: number;
  usd: number;
}

/**
 * A machine-readable recovery path for a job that could not continue.
 *
 * Retrieval failures are product failures or explicit user-action states; they
 * must never be represented as "no insight found". Keeping the action typed is
 * what lets every client offer the right recovery control instead of parsing a
 * human status message.
 */
export interface JobRequiredAction {
  kind: 'connect_social' | 'configure_provider' | 'retry' | 'increase_budget';
  message: string;
  platform?: SocialPlatform | null;
}

export interface Job {
  jobId: string;
  userId: string;
  /**
   * For a `link` capture this is the real URL. Text, voice and photo captures
   * get a synthetic `aiapp:` URI derived from a content hash, which keeps
   * de-duplication, folder naming and the index working unchanged.
   */
  url: string;
  normalizedUrl: string;
  inputKind: InputKind;
  /** Raw text for a note capture, or the transcript of a dictated one. */
  bodyText?: string | null;
  sharedText?: string | null;
  note?: string | null;
  platform: Platform;
  state: JobState;
  /** Human-readable explanation of the current state, surfaced in the UI. BR-U7. */
  statusMessage?: string | null;
  /** Stable operator-facing code for diagnostics and support. */
  failureCode?: string | null;
  /** The next action the UI can offer when processing is blocked. */
  requiredAction?: JobRequiredAction | null;
  title?: string | null;
  captureSource: CaptureSource;
  folderName?: string | null;
  cost: JobCost;
  attempts: number;
  /** Phase-A result. Present from TRIAGED onward. */
  triageVerdict?: TriageVerdict | null;
  valueScore?: number | null;
  domains: LifeDomain[];
  createdAt: string;
  updatedAt: string;
}

// ─── Understanding ───────────────────────────────────────────────────────────

/**
 * Where a piece of text came from. Ordered cheapest/highest-fidelity first,
 * matching the extraction waterfall in spec §6.2.
 */
export const PROVENANCES = [
  'post_description',
  'author_caption',
  'auto_caption',
  'asr_whisper',
  'asr_hosted',
  'ocr_multimodal',
  'ocr_tesseract',
  'browser_dom',
  'user_note',
] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** Nominal confidence per extraction method. Spec §6.2 accuracy notes. */
export const PROVENANCE_CONFIDENCE: Record<Provenance, number> = {
  post_description: 1.0,
  author_caption: 0.99,
  auto_caption: 0.9,
  asr_whisper: 0.88,
  asr_hosted: 0.9,
  ocr_multimodal: 0.95,
  ocr_tesseract: 0.82,
  browser_dom: 0.85,
  user_note: 1.0,
};

export interface InsightSegment {
  order: number;
  text: string;
  provenance: Provenance;
  confidence: number;
  /** Seconds into the media, when the source is time-coded. */
  startSec?: number | null;
  /** Slide/frame index for carousels and sampled frames. */
  frameIndex?: number | null;
}

export interface InsightSource {
  insightSourceId: string;
  jobId: string;
  segments: InsightSegment[];
  postDescription?: string | null;
  language: string;
  durationSec?: number | null;
  /** Aggregate confidence across segments; drives the low-confidence flag. BR-U5. */
  overallConfidence: number;
  /** True when the best available text is thin or low confidence. Spec §6.5. */
  lowConfidence: boolean;
  /** Ordered list of methods actually used, for source transparency. */
  methodsUsed: Provenance[];
  createdAt: string;
}

// ─── Life context graph ──────────────────────────────────────────────────────

/**
 * Areas of life the app can propose action in.
 *
 * The original build only ever operated on the user's AI environment. A tip
 * about a book, a rate change or a sleep routine had nowhere to land. Domains
 * let the analyzer classify what it is looking at and pick item types that
 * actually fit the advice.
 */
export const LIFE_DOMAINS = [
  'ai_workflow',
  'learning',
  'money',
  'health',
  'career',
  'home',
  'relationships',
  'travel',
  'other',
] as const;
export type LifeDomain = (typeof LIFE_DOMAINS)[number];

export const LIFE_DOMAIN_LABELS: Record<LifeDomain, string> = {
  ai_workflow: 'AI & workflow',
  learning: 'Learning',
  money: 'Money',
  health: 'Health',
  career: 'Career',
  home: 'Home & family',
  relationships: 'Relationships',
  travel: 'Travel',
  other: 'Other',
};

/** Kinds of fact the life context graph holds. */
export const FACT_CATEGORIES = [
  'identity',
  'household',
  'device',
  'service',
  'tool',
  'preference',
  'goal',
  'constraint',
  'routine',
  'skill',
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

export const FACT_CATEGORY_LABELS: Record<FactCategory, string> = {
  identity: 'About you',
  household: 'Household',
  device: 'Devices',
  service: 'Subscriptions & accounts',
  tool: 'Tools you work in',
  preference: 'Preferences',
  goal: 'Goals',
  constraint: 'Constraints',
  routine: 'Routines',
  skill: 'Skills',
};

/**
 * How a fact entered the graph.
 *
 * `inferred` facts are proposals: the analyzer noticed something while reading a
 * capture and suggests adding it. They stay unconfirmed — and are excluded from
 * the analyzer's context — until the user accepts them, so the system can never
 * quietly build a picture of someone they did not agree to.
 */
export const FACT_SOURCES = ['user_stated', 'onboarding', 'inferred', 'observed'] as const;
export type FactSource = (typeof FACT_SOURCES)[number];

export interface ProfileFact {
  factId: string;
  userId: string;
  category: FactCategory;
  /** Short stable handle, e.g. `phone`, `audiobook_preference`. */
  key: string;
  /** The fact in plain language: "iPhone 15 Pro". */
  value: string;
  /** Optional elaboration the analyzer may use when reasoning. */
  detail?: string | null;
  source: FactSource;
  confidence: number;
  /** Unconfirmed inferred facts are proposals, not context. */
  confirmed: boolean;
  /** Set when the fact was proposed while analysing a capture. */
  jobId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The assembled, token-budgeted view of a person handed to the analyzer. */
export interface LifeContext {
  facts: ProfileFact[];
  /** Rendered prose block injected into the analysis prompt. */
  brief: string;
  factCount: number;
  /** Facts still awaiting the user's confirmation — surfaced as an inbox. */
  pendingCount: number;
}

// ─── Triage (phase A) ────────────────────────────────────────────────────────

export const TRIAGE_VERDICTS = ['actionable', 'reference_only', 'no_action'] as const;
export type TriageVerdict = (typeof TRIAGE_VERDICTS)[number];

/**
 * The cheap first pass. Triage decides whether a capture is worth the expensive
 * planning call at all, which is what keeps a day of idle scrolling from costing
 * real money.
 */
export interface TriageResult {
  verdict: TriageVerdict;
  domains: LifeDomain[];
  /** 0–1 estimate of how much a full plan would be worth to this person. */
  valueScore: number;
  /** One line the user sees before deciding to spend a deep plan on it. */
  headline: string;
  estimatedItems: number;
  usage: { modelTokens: number; usd: number };
  engine: 'claude' | 'offline';
}

// ─── Analysis & spec ─────────────────────────────────────────────────────────

/**
 * Item types. Each maps to a least-privilege permission scope in the
 * implementation engine. Spec §9 "Item typing & scopes".
 *
 * The first eight act on the user's AI environment. The rest act on the rest of
 * their life — acquiring a book in the format they actually consume, drafting an
 * introduction, standing up an automation — which is the difference between a
 * summarizer and something that moves your week forward.
 */
export const ITEM_TYPES = [
  'create_skill',
  'set_instruction',
  'schedule_task',
  'connect_tool',
  'download_file',
  'generate_file',
  'configure_setting',
  'run_command',
  'acquire_media',
  'purchase',
  'build_habit',
  'learn_topic',
  'contact_person',
  'research_topic',
  'create_project',
  'automation_workflow',
  'financial_review',
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  create_skill: 'Create a skill',
  set_instruction: 'Set an instruction',
  schedule_task: 'Schedule it',
  connect_tool: 'Connect a tool',
  download_file: 'Download',
  generate_file: 'Generate a file',
  configure_setting: 'Change a setting',
  run_command: 'Run a command',
  acquire_media: 'Get the book or course',
  purchase: 'Buy it',
  build_habit: 'Build the habit',
  learn_topic: 'Learn it',
  contact_person: 'Reach out',
  research_topic: 'Look into it',
  create_project: 'Set up a project',
  automation_workflow: 'Automate it',
  financial_review: 'Review the money',
};

export const EFFORT_LEVELS = ['low', 'medium', 'high'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];
export const IMPACT_LEVELS = ['low', 'medium', 'high'] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];

/** Risk tiers the trust dial operates on. Spec §9 "Trust dial". */
export const RISK_TIERS = ['safe', 'moderate', 'sensitive'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const ITEM_TYPE_RISK: Record<ItemType, RiskTier> = {
  create_skill: 'safe',
  set_instruction: 'safe',
  generate_file: 'safe',
  schedule_task: 'moderate',
  configure_setting: 'moderate',
  download_file: 'moderate',
  connect_tool: 'sensitive',
  run_command: 'sensitive',
  // Life-domain items. Anything that produces a plan, a draft or a document is
  // safe; anything that would spend money or speak to another human on the
  // user's behalf is sensitive and never auto-runs under the default posture.
  build_habit: 'safe',
  learn_topic: 'safe',
  research_topic: 'safe',
  create_project: 'safe',
  acquire_media: 'moderate',
  automation_workflow: 'moderate',
  contact_person: 'moderate',
  purchase: 'sensitive',
  financial_review: 'sensitive',
};

/** Permission scopes an item may request. The engine may use nothing else. */
export const PERMISSION_SCOPES = [
  'artifacts:write',
  'skills:write',
  'instructions:write',
  'schedule:write',
  'connectors:read',
  'connectors:write',
  'net:read',
  'browser:operate',
  'shell:exec',
  /** Assemble an order or reading list — never completes a transaction. */
  'commerce:prepare',
  /** Draft a message for the user to send. The engine never sends. */
  'outbox:draft',
  /** Propose additions to the life context graph, subject to confirmation. */
  'profile:write',
] as const;
export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

export const ITEM_TYPE_SCOPES: Record<ItemType, PermissionScope[]> = {
  create_skill: ['artifacts:write', 'skills:write'],
  set_instruction: ['artifacts:write', 'instructions:write'],
  generate_file: ['artifacts:write'],
  schedule_task: ['artifacts:write', 'schedule:write'],
  configure_setting: ['artifacts:write', 'instructions:write'],
  download_file: ['artifacts:write', 'net:read', 'browser:operate'],
  connect_tool: ['artifacts:write', 'connectors:read', 'connectors:write'],
  run_command: ['artifacts:write', 'shell:exec'],
  // Note what is absent: no item type carries a scope that completes a purchase
  // or sends a message. `acquire_media` and `purchase` prepare an order and hand
  // it back; `contact_person` writes a draft. The last step stays with the user.
  build_habit: ['artifacts:write', 'schedule:write'],
  learn_topic: ['artifacts:write'],
  research_topic: ['artifacts:write', 'net:read'],
  create_project: ['artifacts:write', 'skills:write', 'instructions:write'],
  acquire_media: ['artifacts:write', 'commerce:prepare'],
  automation_workflow: ['artifacts:write', 'schedule:write'],
  contact_person: ['artifacts:write', 'outbox:draft'],
  purchase: ['artifacts:write', 'commerce:prepare'],
  financial_review: ['artifacts:write'],
};

export interface SpecItem {
  itemId: string;
  specId: string;
  title: string;
  type: ItemType;
  /** Why this helps — shown in the review UI. BR-A5. */
  why: string;
  /** What the engine will actually do, in plain language. */
  proposedMethod: string;
  prerequisites: string[];
  /** Prerequisites the user does not currently satisfy. BR-A6. */
  missingPrerequisites: string[];
  effort: EffortLevel;
  impact: ImpactLevel;
  riskTier: RiskTier;
  scopes: PermissionScope[];
  requiresBrowser: boolean;
  /** Structured payload the item handler consumes (shape varies by type). */
  parameters: Record<string, unknown>;
  /** Index of the source segments this item was drawn from — grounding trail. */
  sourceSegments: number[];
  /** Set when this repeats something already implemented. BR-A7. */
  duplicateOfItemId?: string | null;
  /** Which area of life this item acts on. */
  domain: LifeDomain;
  /**
   * Profile fact keys that shaped this item — e.g. an item proposing an
   * audiobook cites `audiobook_preference`. Renders as "because you…" in the UI
   * and makes personalization auditable rather than magic.
   */
  personalizedOn: string[];
  ordinal: number;
}

/**
 * A coherent route through one capture.
 *
 * The same post can be acted on several ways: buy the book, read a summary, or
 * turn its argument into a weekly routine. Rather than flattening those into one
 * undifferentiated checklist, the analyzer groups items into pathways and marks
 * one recommended — chosen using what it knows about the person, with the
 * reasoning shown.
 */
export const PATHWAY_STANCES = ['fastest', 'deepest', 'cheapest', 'balanced', 'hands_off'] as const;
export type PathwayStance = (typeof PATHWAY_STANCES)[number];

export const PATHWAY_STANCE_LABELS: Record<PathwayStance, string> = {
  fastest: 'Fastest',
  deepest: 'Most thorough',
  cheapest: 'Lowest cost',
  balanced: 'Balanced',
  hands_off: 'Hands off',
};

export interface Pathway {
  pathwayId: string;
  specId: string;
  /** Human label: "Listen on the commute". */
  label: string;
  stance: PathwayStance;
  /** Why this route suits *this* person, citing what the app knows about them. */
  rationale: string;
  /** Profile fact keys the rationale leaned on — the personalization trail. */
  groundedInFacts: string[];
  estimatedMinutes: number;
  estimatedCostUsd: number;
  /** Items belonging to this route; approving the pathway approves all of them. */
  itemIds: string[];
  recommended: boolean;
  ordinal: number;
}

export interface Spec {
  specId: string;
  jobId: string;
  userId: string;
  title: string;
  summaryPlainEnglish: string;
  /** The full technical write-up rendered into 04_spec.md/docx. */
  technicalSpec: string;
  /** True when the content carried no actionable advice. BR-A1 / use case 9.4. */
  noActionableItems: boolean;
  items: SpecItem[];
  /** Empty for a single-route plan; the UI then shows a flat item list. */
  pathways: Pathway[];
  /** Domains this capture touches, most significant first. */
  domains: LifeDomain[];
  /** Facts the analyzer proposes adding about the user, pending confirmation. */
  proposedFacts: ProposedFact[];
  createdAt: string;
}

/** A fact the analyzer noticed while reading a capture. Never auto-applied. */
export interface ProposedFact {
  category: FactCategory;
  key: string;
  value: string;
  detail?: string | null;
  confidence: number;
  /** What in the capture suggested it — shown so the user can judge. */
  evidence: string;
}

// ─── Decisions ───────────────────────────────────────────────────────────────

export const DECISION_CHOICES = ['approve', 'forgo', 'defer'] as const;
export type DecisionChoice = (typeof DECISION_CHOICES)[number];

export interface Decision {
  decisionId: string;
  specId: string;
  itemId: string;
  userId: string;
  decision: DecisionChoice;
  /** Light edits the user made before approving. BR-R5. */
  edits?: Record<string, unknown> | null;
  decidedAt: string;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/** Per-item outcome vocabulary. Spec §9 "Failure semantics" / BR-I7. */
export const ITEM_RESULT_STATUSES = [
  'done',
  'partial',
  'needs_input',
  'not_possible',
  'skipped',
  'dry_run',
] as const;
export type ItemResultStatus = (typeof ITEM_RESULT_STATUSES)[number];

export const RUN_STATUSES = ['queued', 'running', 'done', 'partial', 'needs_input', 'failed'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface RunAction {
  at: string;
  itemId: string | null;
  /** Short verb phrase, e.g. "wrote file" or "registered schedule". */
  action: string;
  detail: string;
  scope: PermissionScope | null;
  ok: boolean;
}

export interface ItemResult {
  itemId: string;
  title: string;
  type: ItemType;
  status: ItemResultStatus;
  /** One-line human-readable outcome. BR-I7. */
  summary: string;
  actions: string[];
  artifacts: string[];
  reversible: boolean;
  /** Instructions the undo endpoint replays. BR-I6. */
  undo?: { kind: string; target: string }[] | null;
  /** Populated for a "needs_input" outcome so the UI can ask the right question. */
  needsInput?: string | null;
}

export interface ImplementationRun {
  runId: string;
  specId: string;
  jobId: string;
  userId: string;
  status: RunStatus;
  /** True when the run only previewed changes. Spec §9 "Dry-run preview". */
  dryRun: boolean;
  items: ItemResult[];
  actions: RunAction[];
  /**
   * Items the user explicitly confirmed after the trust dial held them back.
   * Confirmation is per-item and per-run: it never widens the trust posture,
   * so saying yes to one purchase does not make the next one automatic.
   */
  confirmedItemIds: string[];
  startedAt: string;
  finishedAt?: string | null;
  overall: ItemResultStatus | 'mixed' | null;
}

// ─── Users, preferences, connectors ──────────────────────────────────────────

export const TRUST_POSTURES = ['cautious', 'balanced', 'just_do_it'] as const;
export type TrustPosture = (typeof TRUST_POSTURES)[number];

/**
 * Which risk tiers auto-implement on approval vs. need a second confirmation.
 * Spec §9 "Trust dial".
 */
export const TRUST_AUTO_TIERS: Record<TrustPosture, RiskTier[]> = {
  cautious: [],
  balanced: ['safe'],
  just_do_it: ['safe', 'moderate', 'sensitive'],
};

export interface UserPreferences {
  trustPosture: TrustPosture;
  /** Per-tier override of the posture default. */
  autoImplementTiers?: RiskTier[] | null;
  notifyChannels: string[];
  quietHours: { start: number; end: number } | null;
  /** Absolute path on the user's machine the desktop bridge writes into. */
  desktopFolder: string | null;
  weeklyDigest: boolean;
  dryRunFirst: boolean;
  /**
   * Free-text description of the user's actual life: the apps and devices they
   * use, where they spend time, who they answer to, what they are working on.
   *
   * This is what turns "here is a generic tip" into "here is how this fits your
   * Tuesday". Without it the analyzer can only restate the post; with it, it can
   * name the specific tool or moment where the advice would land.
   */
  personalContext: string | null;
  /**
   * Triage value score at or above which a capture is planned automatically.
   * Below it the capture rests in AWAITING_PLAN until the user taps "Plan this",
   * so scrolling stays cheap and only what matters costs a deep call. Set to 0
   * to plan everything, 1.01 to plan nothing automatically.
   */
  autoPlanThreshold: number;
  /** Domains the user does not want proposals in, e.g. someone who wants no health advice. */
  mutedDomains: LifeDomain[];
  /** Let the analyzer propose additions to the life context graph. */
  learnAboutMe: boolean;
}

export interface User {
  userId: string;
  email: string;
  displayName: string;
  createdAt: string;
  preferences: UserPreferences;
  /** Rolls up spend for budget enforcement and operator visibility. */
  usage?: { usdToday: number; usdTotal: number; jobsTotal: number };
}

export interface Connector {
  connectorId: string;
  userId: string;
  /** e.g. "github", "slack", "gmail", "filesystem", "rally". */
  kind: string;
  label: string;
  /** Never returned to the client — presence only. */
  configured: boolean;
  scopes: string[];
  createdAt: string;
}

// ─── Library / index ─────────────────────────────────────────────────────────

export interface LibraryEntry {
  jobId: string;
  url: string;
  platform: Platform;
  inputKind: InputKind;
  title: string;
  state: JobState;
  statusMessage?: string | null;
  specId?: string | null;
  runId?: string | null;
  itemCounts: { total: number; approved: number; forgone: number; deferred: number; pending: number };
  folderPath?: string | null;
  lowConfidence: boolean;
  domains: LifeDomain[];
  triageVerdict?: TriageVerdict | null;
  valueScore?: number | null;
  cost: JobCost;
  createdAt: string;
  updatedAt: string;
}

// ─── API payloads ────────────────────────────────────────────────────────────

export interface CaptureRequest {
  url: string;
  sharedText?: string;
  note?: string;
  captureSource?: CaptureSource;
  /** Client-generated id so an offline queue can retry without duplicating. */
  clientRef?: string;
}

/**
 * The universal capture payload. `kind` decides which fields matter:
 *   link  → `url`
 *   text  → `text`
 *   voice → `media` (audio), transcribed on arrival
 *   image → `media` (photo), read with OCR/vision
 *   email → `text` plus optional `subject`
 */
export interface UniversalCaptureRequest {
  kind: InputKind;
  url?: string;
  text?: string;
  subject?: string;
  /** Base64 payload for voice and photo captures. */
  media?: { data: string; mimeType: string; filename?: string };
  note?: string;
  captureSource?: CaptureSource;
  clientRef?: string;
}

export interface CaptureResponse {
  jobId: string;
  state: JobState;
  /** True when this URL was already captured and the existing job was returned. */
  deduped: boolean;
}

export interface DecisionRequest {
  items: { itemId: string; decision: DecisionChoice; edits?: Record<string, unknown> }[];
  /**
   * Approve every item on one pathway and forgo the rest. This is the
   * "pick this route" button; `items` may be omitted when it is set, and any
   * entries given override the pathway default for those items.
   */
  pathwayId?: string;
  /** Force a preview-only run regardless of the trust dial. */
  dryRun?: boolean;
}

// ─── Profile API ─────────────────────────────────────────────────────────────

export interface ProfileResponse {
  facts: ProfileFact[];
  /** Facts proposed by the analyzer, awaiting confirmation. */
  pending: ProfileFact[];
  brief: string;
  /** 0–1: how complete the picture is, used to nudge onboarding along. */
  completeness: number;
  /** Categories with nothing in them yet — what to ask about next. */
  gaps: FactCategory[];
}

export interface UpsertFactRequest {
  category: FactCategory;
  key: string;
  value: string;
  detail?: string | null;
}

export interface ConfirmRequest {
  /** Items to run despite the trust dial holding them. */
  itemIds: string[];
}

export interface DecisionResponse {
  runId: string | null;
  /** Items held back because the trust dial requires a second confirmation. */
  awaitingConfirmation: string[];
  dryRun: boolean;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}
