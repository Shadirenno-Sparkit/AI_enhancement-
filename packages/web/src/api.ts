import type {
  CaptureResponse,
  Connector,
  DecisionChoice,
  DecisionResponse,
  ImplementationRun,
  Job,
  LibraryEntry,
  Provenance,
  Spec,
  SpecItem,
  User,
  UserPreferences,
} from '@aiapp/shared';

const TOKEN_KEY = 'aiapp.tokens';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms at which the access token stops being usable. */
  expiresAt: number;
}

export function loadTokens(): Tokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}

export function saveTokens(tokens: Tokens | null): void {
  if (tokens) localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let refreshInFlight: Promise<Tokens | null> | null = null;

/**
 * Refreshes the access token, collapsing concurrent callers onto one request.
 *
 * The server rotates refresh tokens single-use, so two parallel refreshes would
 * race and invalidate each other — hence the shared promise.
 */
async function refreshTokens(): Promise<Tokens | null> {
  if (refreshInFlight) return refreshInFlight;

  const current = loadTokens();
  if (!current?.refreshToken) return null;

  refreshInFlight = (async () => {
    try {
      const response = await fetch('/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      if (!response.ok) {
        saveTokens(null);
        return null;
      }
      const body = (await response.json()) as {
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
      };
      const next: Tokens = {
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        expiresAt: Date.now() + body.expiresIn * 1000,
      };
      saveTokens(next);
      return next;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean; retry?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, auth = true, retry = true } = options;

  let tokens = loadTokens();
  // Refresh a few seconds early so a request never races the expiry.
  if (auth && tokens && tokens.expiresAt - 5000 < Date.now()) {
    tokens = await refreshTokens();
  }

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && tokens) headers['Authorization'] = `Bearer ${tokens.accessToken}`;

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 401 && auth && retry) {
    const refreshed = await refreshTokens();
    if (refreshed) return request<T>(path, { ...options, retry: false });
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const error = payload as { error?: string; message?: string; details?: unknown } | null;
    throw new ApiError(
      response.status,
      error?.error ?? 'error',
      error?.message ?? `Request failed (${response.status})`,
      error?.details,
    );
  }

  return payload as T;
}

// ─── Types the API returns beyond the shared model ───────────────────────────

export interface SourceExcerpt {
  order: number;
  text: string;
  provenance: Provenance;
  confidence: number;
}

export interface ReviewItem extends SpecItem {
  decision: DecisionChoice | null;
  edits: Record<string, unknown> | null;
  sourceExcerpts: SourceExcerpt[];
  autonomy: { autoImplement: boolean; dryRun: boolean; reason: string };
  affinity: { approve: number; forgo: number; defer: number } | null;
}

export interface SpecView {
  spec: Omit<Spec, 'items'> & { items: ReviewItem[] };
  job: Job | null;
  extraction: {
    overallConfidence: number;
    lowConfidence: boolean;
    methodsUsed: Provenance[];
    language: string;
    durationSec: number | null;
    segmentCount: number;
  } | null;
  run: ImplementationRun | null;
}

export interface JobStatus {
  job: Job;
  specId: string | null;
  itemCount: number;
  decidedCount: number;
  runId: string | null;
  runStatus: string | null;
  lowConfidence: boolean;
  progress: number;
}

export interface Capabilities {
  analysis: { provider: string; live: boolean };
  speechToText: { provider: string; live: boolean };
  vision: { provider: string; live: boolean };
  browserAgent: boolean;
  autonomousImplementation: boolean;
  signupOpen: boolean;
  pushPublicKey: string | null;
  budgets: { maxUsdPerLink: number; maxUsdPerUserPerDay: number };
}

export interface Digest {
  periodDays: number;
  since: string;
  totals: { captured: number; approved: number; forgone: number; deferred: number; pending: number; usd: number };
  captureToActionRate: number;
  byPlatform: Record<string, number>;
  implemented: { title: string; type: string; summary: string; runId: string; at: string }[];
  needsYou: { title: string; needsInput: string | null; runId: string }[];
  awaitingReview: { jobId: string; title: string; items: number }[];
  lowConfidence: { jobId: string; title: string }[];
  preferenceProfile: Record<string, { approve: number; forgo: number; defer: number }>;
}

export interface ScheduledTaskView {
  taskId: string;
  name: string;
  cron: string;
  humanReadable: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export interface NotificationView {
  notificationId: string;
  title: string;
  body: string;
  kind: string;
  read: boolean;
  jobId: string | null;
  createdAt: string;
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

export const api = {
  capabilities: () => request<Capabilities>('/v1/capabilities', { auth: false }),

  signup: (email: string, password: string, displayName?: string) =>
    request<{ user: User; accessToken: string; refreshToken: string; expiresIn: number }>('/v1/auth/signup', {
      method: 'POST',
      body: { email, password, displayName },
      auth: false,
    }),

  login: (email: string, password: string) =>
    request<{ user: User; accessToken: string; refreshToken: string; expiresIn: number }>('/v1/auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    }),

  logout: () => request<void>('/v1/auth/logout', { method: 'POST' }),

  me: () => request<{ user: User }>('/v1/auth/me'),

  capture: (input: { url: string; sharedText?: string; note?: string; captureSource?: string; clientRef?: string }) =>
    request<CaptureResponse>('/v1/links', { method: 'POST', body: input }),

  library: (limit = 100) => request<{ entries: LibraryEntry[] }>(`/v1/library?limit=${limit}`),

  jobStatus: (jobId: string) => request<JobStatus>(`/v1/jobs/${jobId}`),

  spec: (specId: string) => request<SpecView>(`/v1/specs/${specId}`),

  decide: (specId: string, items: { itemId: string; decision: DecisionChoice; edits?: Record<string, unknown> }[], dryRun?: boolean) =>
    request<DecisionResponse>(`/v1/specs/${specId}/decisions`, { method: 'POST', body: { items, dryRun } }),

  revert: (specId: string, itemId: string) =>
    request<{ reverted: boolean; steps: string[] }>(`/v1/specs/${specId}/revert/${itemId}`, { method: 'POST' }),

  run: (runId: string) => request<{ run: ImplementationRun }>(`/v1/runs/${runId}`),

  rerun: (jobId: string) => request<{ jobId: string }>(`/v1/links/${jobId}/rerun`, { method: 'POST' }),

  deleteLink: (jobId: string) => request<void>(`/v1/links/${jobId}`, { method: 'DELETE' }),

  files: (jobId: string) => request<{ folderName: string; files: string[] }>(`/v1/artifacts/${jobId}/files`),

  fileUrl: (jobId: string, filePath: string) =>
    `/v1/artifacts/${jobId}/file?path=${encodeURIComponent(filePath)}&access_token=${encodeURIComponent(
      loadTokens()?.accessToken ?? '',
    )}`,

  exportUrl: (jobId: string) =>
    `/v1/artifacts/${jobId}/export?access_token=${encodeURIComponent(loadTokens()?.accessToken ?? '')}`,

  exportAllUrl: () =>
    `/v1/artifacts/export/all?access_token=${encodeURIComponent(loadTokens()?.accessToken ?? '')}`,

  preferences: (patch: Partial<UserPreferences>) =>
    request<{ user: User }>('/v1/users/me/preferences', { method: 'PATCH', body: patch }),

  usage: () =>
    request<{
      today: { usd: number; asrSeconds: number; modelTokens: number; jobs: number };
      total: { usd: number; jobs: number };
      limits: { maxUsdPerLink: number; maxUsdPerUserPerDay: number; maxAsrSecondsPerLink: number };
    }>('/v1/users/me/usage'),

  connectors: () => request<{ connectors: Connector[] }>('/v1/users/me/connectors'),

  saveConnector: (kind: string, input: { label?: string; secret?: string | null; scopes?: string[] }) =>
    request<{ connector: Connector }>(`/v1/users/me/connectors/${kind}`, { method: 'PUT', body: input }),

  deleteConnector: (kind: string) => request<void>(`/v1/users/me/connectors/${kind}`, { method: 'DELETE' }),

  schedules: () => request<{ tasks: ScheduledTaskView[] }>('/v1/users/me/schedules'),

  setSchedule: (taskId: string, enabled: boolean) =>
    request<{ updated: boolean }>(`/v1/users/me/schedules/${taskId}`, { method: 'PATCH', body: { enabled } }),

  deleteSchedule: (taskId: string) => request<void>(`/v1/users/me/schedules/${taskId}`, { method: 'DELETE' }),

  notifications: () => request<{ notifications: NotificationView[] }>('/v1/users/me/notifications'),

  markRead: (ids?: string[]) =>
    request<{ updated: number }>('/v1/users/me/notifications/read', { method: 'POST', body: { ids } }),

  savePushSubscription: (subscription: PushSubscriptionJSON) =>
    request<{ saved: boolean }>('/v1/users/me/push-subscription', {
      method: 'POST',
      body: { endpoint: subscription.endpoint, keys: subscription.keys },
    }),

  digest: (days = 7) => request<Digest>(`/v1/digest?days=${days}`),

  auditLog: (limit = 200) =>
    request<{ events: { auditId: number; event: string; detail: string | null; scope: string | null; at: string }[] }>(
      `/v1/users/me/audit?limit=${limit}`,
    ),

  deleteAllData: (keepAccount = true) =>
    request<{ deleted: boolean }>(`/v1/users/me/data?keepAccount=${keepAccount}`, { method: 'DELETE' }),
};
