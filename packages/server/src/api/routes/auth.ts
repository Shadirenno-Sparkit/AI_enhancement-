import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { audit } from '../../repo/audit.js';
import {
  consumeRefreshToken,
  createUser,
  countUsers,
  getUserByEmail,
  getUserById,
  revokeAllRefreshTokens,
  storeRefreshToken,
  usageToday,
  usageTotal,
  verifyPassword,
} from '../../repo/users.js';
import { badRequest, conflict, forbidden, unauthorized } from '../../util/errors.js';
import { randomToken } from '../../util/ids.js';
import { asyncHandler, currentUser, rateLimit, requireAuth, signAccessToken } from '../middleware.js';

const credentials = z.object({
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(10, 'Use at least 10 characters.').max(200),
  displayName: z.string().min(1).max(80).optional(),
});

export const authRouter = Router();

// Deliberately tight: 5 attempts, refilling at one per 30s.
const authLimit = rateLimit({ capacity: 5, refillPerSecond: 1 / 30, key: 'auth' });

authRouter.post(
  '/signup',
  authLimit,
  asyncHandler(async (req, res) => {
    const cfg = config();
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) throw badRequest('Check your details.', parsed.error.flatten().fieldErrors);

    // The first account always succeeds so a fresh deployment is usable; after
    // that, ALLOW_SIGNUP=false locks a personal instance down.
    if (!cfg.allowSignup && countUsers() > 0) {
      throw forbidden('Sign-ups are closed on this deployment.');
    }
    if (getUserByEmail(parsed.data.email)) throw conflict('That email already has an account.');

    const user = createUser(parsed.data.email, parsed.data.password, parsed.data.displayName);
    audit({ userId: user.userId, event: 'auth.signup', detail: user.email });

    const refreshToken = randomToken();
    storeRefreshToken(user.userId, refreshToken, cfg.refreshTokenTtl);

    res.status(201).json({
      user,
      accessToken: signAccessToken(user),
      refreshToken,
      expiresIn: cfg.accessTokenTtl,
    });
  }),
);

authRouter.post(
  '/login',
  authLimit,
  asyncHandler(async (req, res) => {
    const cfg = config();
    const parsed = z
      .object({ email: z.string().email(), password: z.string().min(1).max(200) })
      .safeParse(req.body);
    if (!parsed.success) throw badRequest('Enter your email and password.');

    const user = verifyPassword(parsed.data.email, parsed.data.password);
    if (!user) {
      audit({ event: 'auth.failed', detail: parsed.data.email });
      throw unauthorized('That email and password combination is not right.');
    }

    const refreshToken = randomToken();
    storeRefreshToken(user.userId, refreshToken, cfg.refreshTokenTtl);
    audit({ userId: user.userId, event: 'auth.login' });

    res.json({ user, accessToken: signAccessToken(user), refreshToken, expiresIn: cfg.accessTokenTtl });
  }),
);

authRouter.post(
  '/refresh',
  rateLimit({ capacity: 30, refillPerSecond: 1, key: 'refresh' }),
  asyncHandler(async (req, res) => {
    const parsed = z.object({ refreshToken: z.string().min(10) }).safeParse(req.body);
    if (!parsed.success) throw badRequest('A refresh token is required.');

    // Single-use rotation: consuming returns the owner and invalidates the token.
    const userId = consumeRefreshToken(parsed.data.refreshToken);
    if (!userId) throw unauthorized('That session has expired. Sign in again.');

    const user = getUserById(userId);
    if (!user) throw unauthorized('This account no longer exists.');

    const cfg = config();
    const next = randomToken();
    storeRefreshToken(user.userId, next, cfg.refreshTokenTtl);

    res.json({ user, accessToken: signAccessToken(user), refreshToken: next, expiresIn: cfg.accessTokenTtl });
  }),
);

authRouter.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    revokeAllRefreshTokens(user.userId);
    audit({ userId: user.userId, event: 'auth.logout' });
    res.status(204).end();
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    res.json({
      user: {
        ...user,
        usage: {
          usdToday: Number(usageToday(user.userId).usd.toFixed(4)),
          usdTotal: Number(usageTotal(user.userId).usd.toFixed(4)),
          jobsTotal: usageTotal(user.userId).jobs,
        },
      },
    });
  }),
);
