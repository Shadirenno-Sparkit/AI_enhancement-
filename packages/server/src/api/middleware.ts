import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { User } from '@aiapp/shared';
import { config } from '../config.js';
import { audit } from '../repo/audit.js';
import { getUserById } from '../repo/users.js';
import { HttpError, unauthorized } from '../util/errors.js';
import { createLogger, errorMessage } from '../util/logger.js';

const log = createLogger('api');

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      requestId?: string;
    }
  }
}

export interface AccessTokenClaims {
  sub: string;
  email: string;
  typ: 'access';
}

export function signAccessToken(user: User): string {
  const cfg = config();
  return jwt.sign({ sub: user.userId, email: user.email, typ: 'access' } satisfies AccessTokenClaims, cfg.jwtSecret, {
    expiresIn: cfg.accessTokenTtl,
    issuer: 'ai-enhancement-app',
  });
}

function verifyAccessToken(token: string): AccessTokenClaims | null {
  try {
    const claims = jwt.verify(token, config().jwtSecret, { issuer: 'ai-enhancement-app' }) as AccessTokenClaims;
    return claims.typ === 'access' ? claims : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the caller and attaches them to the request.
 *
 * Every user-scoped route sits behind this, and every repository read takes the
 * resolved userId — that pairing is what makes per-user isolation (BR-S2) hold
 * even if a handler forgets to check ownership itself.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  // The PWA's service worker cannot set headers on a share-target navigation,
  // so a short-lived token may also arrive as a query parameter there.
  const token = bearer ?? (typeof req.query['access_token'] === 'string' ? req.query['access_token'] : null);

  if (!token) return next(unauthorized());

  const claims = verifyAccessToken(token);
  if (!claims) return next(unauthorized('Your session has expired. Sign in again.'));

  const user = getUserById(claims.sub);
  if (!user) return next(unauthorized('This account no longer exists.'));

  req.user = user;
  next();
}

export function currentUser(req: Request): User {
  if (!req.user) throw unauthorized();
  return req.user;
}

// ─── Rate limiting (spec §5.2) ───────────────────────────────────────────────

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Token-bucket limiter keyed by user (or IP when unauthenticated).
 *
 * Capture is deliberately generous and auth deliberately tight: losing a shared
 * link because you tapped twice would break the product's core promise, whereas
 * password guessing should get expensive quickly.
 */
export function rateLimit(options: { capacity: number; refillPerSecond: number; key?: string }) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const identity = req.user?.userId ?? req.ip ?? 'anonymous';
    const bucketKey = `${options.key ?? req.path}:${identity}`;
    const now = Date.now();

    const bucket = buckets.get(bucketKey) ?? { tokens: options.capacity, updatedAt: now };
    const elapsed = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(options.capacity, bucket.tokens + elapsed * options.refillPerSecond);
    bucket.updatedAt = now;

    if (bucket.tokens < 1) {
      buckets.set(bucketKey, bucket);
      const retryAfter = Math.ceil((1 - bucket.tokens) / options.refillPerSecond);
      return next(
        new HttpError(429, 'rate_limited', `Too many requests. Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`),
      );
    }

    bucket.tokens -= 1;
    buckets.set(bucketKey, bucket);
    next();
  };
}

/** Keeps the limiter's memory bounded on a long-running process. */
export function pruneRateLimitBuckets(maxAgeMs = 3_600_000): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const [key, bucket] of buckets) {
    if (bucket.updatedAt < cutoff) buckets.delete(key);
  }
}

export function resetRateLimits(): void {
  buckets.clear();
}

// ─── Errors & logging ────────────────────────────────────────────────────────

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - started;
    // Health checks would otherwise dominate the log.
    if (req.path === '/health') return;
    log.debug(`${req.method} ${req.path}`, {
      status: res.statusCode,
      ms: duration,
      userId: req.user?.userId,
    });
  });
  next();
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: 'not_found', message: 'No such endpoint.' });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    if (err.status >= 500) log.error(err.message, { path: req.path });
    res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
    return;
  }

  const message = errorMessage(err);
  log.error('unhandled error', { path: req.path, method: req.method, error: message });
  // Internal details never reach the client.
  res.status(500).json({
    error: 'internal_error',
    message: 'Something went wrong on our side. The failure has been logged.',
  });

  if (req.user) {
    audit({ userId: req.user.userId, event: 'error.unhandled', detail: `${req.method} ${req.path}: ${message}` });
  }
}

/** Wraps an async handler so a rejected promise reaches the error handler. */
export function asyncHandler<T extends Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req as T, res, next).catch(next);
  };
}
