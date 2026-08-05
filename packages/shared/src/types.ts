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

/** How a link entered the system. BR-C1 / BR-C2 / BR-C3. */
export const CAPTURE_SOURCES = ['share_target', 'share_extension', 'paste', 'api', 'import'] as const;
export type CaptureSource = (typeof CAPTURE_SOURCES)[number];

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

/** Ordering used to prevent the state machine from moving backwards. */
export const JOB_STATE_ORDER: Record<JobState, number> = {
  RECEIVED: 0,
  RESOLVED: 1,
  FETCHED: 2,
  TRANSCRIBED: 3,
  NORMALIZED: 4,
  ANALYZED: 5,
  SPEC_READY: 6,
  AWAITING_DECISION: 7,
  IMPLEMENTING: 8,
  DONE: 9,
  PARTIAL: 9,
  NEEDS_INPUT: 9,
  NO_ACTION: 9,
  FAILED: 9,
};

export interface JobCost {
  asrSeconds: number;
  modelTokens: number;
  usd: number;
}

export interface Job {
  jobId: string;
  userId: string;
  url: string;
  normalizedUrl: string;
  sharedText?: string | null;
  note?: string | null;
  platform: Platform;
  state: JobState;
  /** Human-readable explanation of the current state, surfaced in the UI. BR-U7. */
  statusMessage?: string | null;
  title?: string | null;
  captureSource: CaptureSource;
  folderName?: string | null;
  cost: JobCost;
  attempts: number;
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

// ─── Analysis & spec ─────────────────────────────────────────────────────────

/**
 * Item types. Each maps to a least-privilege permission scope in the
 * implementation engine. Spec §9 "Item typing & scopes".
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
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

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
  createdAt: string;
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
  title: string;
  state: JobState;
  statusMessage?: string | null;
  specId?: string | null;
  runId?: string | null;
  itemCounts: { total: number; approved: number; forgone: number; deferred: number; pending: number };
  folderPath?: string | null;
  lowConfidence: boolean;
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

export interface CaptureResponse {
  jobId: string;
  state: JobState;
  /** True when this URL was already captured and the existing job was returned. */
  deduped: boolean;
}

export interface DecisionRequest {
  items: { itemId: string; decision: DecisionChoice; edits?: Record<string, unknown> }[];
  /** Force a preview-only run regardless of the trust dial. */
  dryRun?: boolean;
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
