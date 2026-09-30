import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SocialPlatform } from '@aiapp/shared';
import { SOCIAL_PLATFORMS } from '@aiapp/shared';
import { config } from '../config.js';
import {
  deleteConnector,
  getConnector,
  revealConnectorSecret,
  upsertConnector,
} from '../repo/connectors.js';
import { randomToken } from '../util/ids.js';

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

export interface BrowserStorageState {
  cookies: StoredCookie[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}

interface AuthPage {
  goto(url: string, options?: unknown): Promise<unknown>;
  bringToFront(): Promise<void>;
}

interface AuthContext {
  newPage(): Promise<AuthPage>;
  storageState(): Promise<BrowserStorageState>;
  close(): Promise<void>;
}

interface AuthBrowser {
  newContext(options?: unknown): Promise<AuthContext>;
  close(): Promise<void>;
}

interface PendingSession {
  sessionId: string;
  userId: string;
  platform: SocialPlatform;
  browser: AuthBrowser;
  context: AuthContext;
  page: AuthPage;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingSession>();
const SESSION_TTL_MS = 10 * 60 * 1000;

const LOGIN_URLS: Record<SocialPlatform, string> = {
  youtube: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F',
  instagram: 'https://www.instagram.com/accounts/login/',
  tiktok: 'https://www.tiktok.com/login',
  x: 'https://x.com/i/flow/login',
  linkedin: 'https://www.linkedin.com/login',
  facebook: 'https://www.facebook.com/login',
};

const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  x: 'X',
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
};

/** Cookies that prove a real signed-in session, rather than consent/theme state. */
const AUTH_COOKIE_NAMES: Record<SocialPlatform, string[]> = {
  youtube: ['SAPISID', '__Secure-1PSID', '__Secure-3PSID'],
  instagram: ['sessionid'],
  tiktok: ['sessionid', 'sessionid_ss', 'sid_guard'],
  x: ['auth_token'],
  linkedin: ['li_at'],
  facebook: ['c_user'],
};

function connectorKind(platform: SocialPlatform): string {
  return `social-${platform}`;
}

export function isSocialPlatform(value: string): value is SocialPlatform {
  return (SOCIAL_PLATFORMS as readonly string[]).includes(value);
}

export function socialAccounts(userId: string): { platform: SocialPlatform; connected: boolean; connectedAt: string | null }[] {
  return SOCIAL_PLATFORMS.map((platform) => {
    const connector = getConnector(userId, connectorKind(platform));
    return {
      platform,
      connected: connector?.configured === true,
      connectedAt: connector?.createdAt ?? null,
    };
  });
}

/**
 * Opens a headed browser on the server host for a one-time login.
 *
 * This is intentionally enabled only in `local_browser` mode. A hosted SaaS
 * must replace the launcher behind this interface with an isolated remote
 * browser/session broker; opening a server-side GUI is not a cloud auth flow.
 */
export async function startSocialSignIn(
  userId: string,
  platform: SocialPlatform,
): Promise<{ sessionId: string; expiresAt: string }> {
  if (config().socialAuthMode !== 'local_browser') {
    throw new Error(
      'One-time social sign-in is not available on this deployment. Configure a secure browser-session provider first.',
    );
  }

  const playwrightSpecifier = 'playwright';
  const playwright = (await import(playwrightSpecifier).catch(() => null)) as {
    chromium: { launch(options?: unknown): Promise<AuthBrowser> };
  } | null;
  if (!playwright) {
    throw new Error('Playwright is not installed. Install it and its Chromium browser before connecting an account.');
  }

  const browser = await playwright.chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
    });
    const page = await context.newPage();
    await page.goto(LOGIN_URLS[platform], { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.bringToFront();

    const sessionId = randomToken(24);
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const timer = setTimeout(() => void closePending(sessionId), SESSION_TTL_MS);
    timer.unref?.();
    pending.set(sessionId, { sessionId, userId, platform, browser, context, page, expiresAt, timer });
    return { sessionId, expiresAt: new Date(expiresAt).toISOString() };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

export async function completeSocialSignIn(
  userId: string,
  platform: SocialPlatform,
  sessionId: string,
): Promise<void> {
  const session = pending.get(sessionId);
  if (!session || session.userId !== userId || session.platform !== platform) {
    throw new Error('That sign-in session expired. Start again.');
  }

  const state = await session.context.storageState();
  const proof = new Set(AUTH_COOKIE_NAMES[platform]);
  if (!state.cookies.some((cookie) => proof.has(cookie.name))) {
    throw new Error(`A ${PLATFORM_LABELS[platform]} login was not detected yet. Finish signing in, then try again.`);
  }

  upsertConnector({
    userId,
    kind: connectorKind(platform),
    label: `${PLATFORM_LABELS[platform]} content access`,
    secret: JSON.stringify(state),
    scopes: ['content:read'],
  });
  await closePending(sessionId);
}

export async function cancelSocialSignIn(userId: string, sessionId: string): Promise<void> {
  const session = pending.get(sessionId);
  if (session?.userId === userId) await closePending(sessionId);
}

export function disconnectSocialAccount(userId: string, platform: SocialPlatform): boolean {
  return deleteConnector(userId, connectorKind(platform));
}

async function closePending(sessionId: string): Promise<void> {
  const session = pending.get(sessionId);
  if (!session) return;
  pending.delete(sessionId);
  clearTimeout(session.timer);
  await session.context.close().catch(() => undefined);
  await session.browser.close().catch(() => undefined);
}

export interface MaterializedSocialSession {
  storageStatePath: string;
  cookiesFilePath: string;
  cleanup: () => Promise<void>;
}

/**
 * Decrypts a user's saved session only for the lifetime of one extraction.
 * The temporary files are mode 0600 and removed in a `finally` block by the
 * pipeline. Browser cookies are never copied into artifacts or shared caches.
 */
export async function materializeSocialSession(
  userId: string,
  platform: string,
): Promise<MaterializedSocialSession | null> {
  if (!isSocialPlatform(platform)) return null;
  const secret = revealConnectorSecret(userId, connectorKind(platform));
  if (!secret) return null;

  let state: BrowserStorageState;
  try {
    state = JSON.parse(secret) as BrowserStorageState;
    if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) return null;
  } catch {
    return null;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiapp-social-'));
  const storageStatePath = path.join(tempDir, 'storage-state.json');
  const cookiesFilePath = path.join(tempDir, 'cookies.txt');
  await fs.writeFile(storageStatePath, JSON.stringify(state), { mode: 0o600 });
  await fs.writeFile(cookiesFilePath, storageStateToNetscape(state), { mode: 0o600 });

  return {
    storageStatePath,
    cookiesFilePath,
    cleanup: () => fs.rm(tempDir, { recursive: true, force: true }),
  };
}

/** Converts Playwright storage state into the cookie file format yt-dlp accepts. */
export function storageStateToNetscape(state: BrowserStorageState): string {
  const clean = (value: string): string => value.replace(/[\t\r\n]/g, '');
  const lines = ['# Netscape HTTP Cookie File', '# Generated temporarily by AI Enhancement App.'];
  for (const cookie of state.cookies) {
    const domain = clean(cookie.domain);
    const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expires = Number.isFinite(cookie.expires) && cookie.expires > 0 ? Math.floor(cookie.expires) : 0;
    lines.push(
      [
        domain,
        includeSubdomains,
        clean(cookie.path || '/'),
        cookie.secure ? 'TRUE' : 'FALSE',
        String(expires),
        clean(cookie.name),
        clean(cookie.value),
      ].join('\t'),
    );
  }
  return `${lines.join('\n')}\n`;
}
