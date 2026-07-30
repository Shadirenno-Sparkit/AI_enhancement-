import { config } from '../config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are redacted before a log line is emitted. */
const SENSITIVE = /^(password|token|secret|authorization|apikey|api_key|refresh|cookie|keys)$/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function minLevel(): number {
  const env = process.env.LOG_LEVEL as Level | undefined;
  if (env && env in LEVEL_ORDER) return LEVEL_ORDER[env];
  return config().isTest ? LEVEL_ORDER.error : LEVEL_ORDER.info;
}

function emit(level: Level, scope: string, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < minLevel()) return;
  const line = {
    at: new Date().toISOString(),
    level,
    scope,
    message,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  };
  const text = config().isProduction ? JSON.stringify(line) : formatPretty(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

function formatPretty(line: Record<string, unknown>): string {
  const { at, level, scope, message, ...rest } = line as Record<string, string>;
  const time = String(at).slice(11, 19);
  const extras = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
  return `${time} ${String(level).toUpperCase().padEnd(5)} [${scope}] ${message}${extras}`;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export const logger = createLogger('app');

/** Normalizes anything thrown into a message safe to log or return. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
