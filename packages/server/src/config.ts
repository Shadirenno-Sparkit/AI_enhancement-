import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnvFile } from 'dotenv';
import type { TrustPosture } from '@aiapp/shared';
import { TRUST_POSTURES } from '@aiapp/shared';

/**
 * Loads `.env` from the repository root, not from the current directory.
 *
 * `import 'dotenv/config'` reads `${process.cwd()}/.env`. In this monorepo the
 * server is started with `npm run start --workspace @aiapp/server`, which sets
 * the cwd to `packages/server/` — where no `.env` exists. The result was silent
 * and total: every key, provider choice and cookie setting in the root `.env`
 * was ignored, the app fell back to hardcoded defaults, and the only symptom
 * was analysis quietly running on the offline analyzer forever.
 *
 * So walk up from this file until a `.env` turns up. Existing environment
 * variables always win, which keeps CI, containers and the test harness in
 * control of their own settings.
 */
function loadDotEnv(): void {
  const candidates: string[] = [];

  // From the compiled module outward: dist/ → packages/server/ → repo root.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    candidates.push(path.join(dir, '.env'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // And the working directory, for anyone running the server directly.
  candidates.push(path.resolve(process.cwd(), '.env'));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      loadEnvFile({ path: candidate });
      break;
    }
  }
}

loadDotEnv();

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function list(key: string, fallback: string[]): string[] {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Expands a leading `~` so BRIDGE_DEST-style paths behave as users expect. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

function resolvePath(p: string): string {
  return path.resolve(expandHome(p));
}

const DEV_JWT_SECRET = 'dev-only-change-me';

export interface Config {
  env: string;
  isProduction: boolean;
  isTest: boolean;
  port: number;
  publicUrl: string;
  corsOrigins: string[];
  jwtSecret: string;
  accessTokenTtl: number;
  refreshTokenTtl: number;
  allowSignup: boolean;
  databasePath: string;
  storagePath: string;
  artifactRoot: string;
  mediaRetentionDays: number;
  anthropicApiKey: string;
  anthropicModel: string;
  anthropicFastModel: string;
  asrProvider: string;
  openaiApiKey: string;
  assemblyAiApiKey: string;
  deepgramApiKey: string;
  whisperBin: string;
  whisperModel: string;
  visionProvider: string;
  tesseractBin: string;
  /** 'auto' | 'claude' | 'openai' | 'offline'. */
  llmProvider: string;
  openaiModel: string;
  openaiFastModel: string;
  /** Overridable so Azure OpenAI and OpenAI-compatible gateways work too. */
  openaiBaseUrl: string;
  openaiInputUsdPerMTok: number;
  openaiOutputUsdPerMTok: number;
  ytdlpBin: string;
  /** Browser to lift cookies from, e.g. "chrome" | "safari" | "firefox". */
  ytdlpCookiesFromBrowser: string;
  /** Path to a Netscape-format cookies.txt, as an alternative to the above. */
  ytdlpCookiesFile: string;
  ffmpegBin: string;
  enableBrowserAgent: boolean;
  maxUsdPerLink: number;
  maxUsdPerUserPerDay: number;
  maxAsrSecondsPerLink: number;
  enableAutonomousImplementation: boolean;
  defaultTrustPosture: TrustPosture;
  workerConcurrency: number;
  notifyChannels: string[];
  smtpUrl: string;
  notifyFrom: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  quietHours: { start: number; end: number };
}

export function loadConfig(): Config {
  const env = str('NODE_ENV', 'development');
  const isProduction = env === 'production';
  const jwtSecret = str('JWT_SECRET', DEV_JWT_SECRET);

  // A deployment reachable from the internet must not sign tokens with the
  // published default. Fail loudly at boot rather than silently insecurely.
  if (isProduction && jwtSecret === DEV_JWT_SECRET) {
    throw new Error(
      'JWT_SECRET is still the development default. Set it to a long random value before running in production.',
    );
  }

  const posture = str('DEFAULT_TRUST_POSTURE', 'balanced');
  const defaultTrustPosture = (TRUST_POSTURES as readonly string[]).includes(posture)
    ? (posture as TrustPosture)
    : 'balanced';

  return {
    env,
    isProduction,
    isTest: env === 'test',
    port: num('PORT', 4000),
    publicUrl: str('PUBLIC_URL', `http://localhost:${num('PORT', 4000)}`),
    corsOrigins: list('CORS_ORIGINS', ['http://localhost:5173']),
    jwtSecret,
    accessTokenTtl: num('ACCESS_TOKEN_TTL', 3600),
    refreshTokenTtl: num('REFRESH_TOKEN_TTL', 2_592_000),
    allowSignup: bool('ALLOW_SIGNUP', true),
    databasePath: resolvePath(str('DATABASE_PATH', './data/aiapp.sqlite')),
    storagePath: resolvePath(str('STORAGE_PATH', './data/storage')),
    artifactRoot: resolvePath(str('ARTIFACT_ROOT', './data/artifacts')),
    mediaRetentionDays: num('MEDIA_RETENTION_DAYS', 14),
    anthropicApiKey: str('ANTHROPIC_API_KEY', ''),
    anthropicModel: str('ANTHROPIC_MODEL', 'claude-opus-4-8'),
    anthropicFastModel: str('ANTHROPIC_FAST_MODEL', 'claude-haiku-4-5'),
    // 'auto' picks whichever key is present (Anthropic wins if both are set).
    llmProvider: str('LLM_PROVIDER', 'auto'),
    // Deliberately overridable and not pinned in code: a wrong model ID here is
    // the single most expensive mistake in this file, because a 404 degrades
    // silently to the offline analyzer. Set it to a model your account has.
    openaiModel: str('OPENAI_MODEL', 'gpt-4o'),
    openaiFastModel: str('OPENAI_FAST_MODEL', 'gpt-4o-mini'),
    openaiBaseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    openaiInputUsdPerMTok: num('OPENAI_INPUT_USD_PER_MTOK', 2.5),
    openaiOutputUsdPerMTok: num('OPENAI_OUTPUT_USD_PER_MTOK', 10),
    // If a model key is present, make the media path useful by default too.
    // Explicit provider settings still override this for local/third-party ASR.
    asrProvider: str('ASR_PROVIDER', 'openai'),
    openaiApiKey: str('OPENAI_API_KEY', ''),
    assemblyAiApiKey: str('ASSEMBLYAI_API_KEY', ''),
    deepgramApiKey: str('DEEPGRAM_API_KEY', ''),
    whisperBin: str('WHISPER_BIN', 'whisper'),
    whisperModel: str('WHISPER_MODEL', 'large-v3'),
    visionProvider: str('VISION_PROVIDER', 'openai'),
    tesseractBin: str('TESSERACT_BIN', 'tesseract'),
    ytdlpBin: str('YTDLP_BIN', 'yt-dlp'),
    // Instagram (and increasingly TikTok) return an empty media response to
    // signed-out clients. Point one of these at your own session to fetch the
    // posts you can already see — see the note in ingestion/fetcher.ts.
    ytdlpCookiesFromBrowser: str('YTDLP_COOKIES_FROM_BROWSER', ''),
    ytdlpCookiesFile: str('YTDLP_COOKIES_FILE', ''),
    ffmpegBin: str('FFMPEG_BIN', 'ffmpeg'),
    enableBrowserAgent: bool('ENABLE_BROWSER_AGENT', true),
    maxUsdPerLink: num('MAX_USD_PER_LINK', 0.75),
    maxUsdPerUserPerDay: num('MAX_USD_PER_USER_PER_DAY', 10),
    maxAsrSecondsPerLink: num('MAX_ASR_SECONDS_PER_LINK', 900),
    enableAutonomousImplementation: bool('ENABLE_AUTONOMOUS_IMPLEMENTATION', true),
    defaultTrustPosture,
    workerConcurrency: num('WORKER_CONCURRENCY', 2),
    notifyChannels: list('NOTIFY_CHANNELS', ['log']),
    smtpUrl: str('SMTP_URL', ''),
    notifyFrom: str('NOTIFY_FROM', 'ai-enhancement-app@localhost'),
    vapidPublicKey: str('VAPID_PUBLIC_KEY', ''),
    vapidPrivateKey: str('VAPID_PRIVATE_KEY', ''),
    quietHours: { start: num('QUIET_HOURS_START', 22), end: num('QUIET_HOURS_END', 7) },
  };
}

let cached: Config | null = null;

/** Process-wide config. `reloadConfig()` exists for tests that mutate env. */
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

export function reloadConfig(): Config {
  cached = loadConfig();
  return cached;
}
