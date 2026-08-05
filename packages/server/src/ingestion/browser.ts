import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger, errorMessage } from '../util/logger.js';

const log = createLogger('browser');

/**
 * Browser capture — the universal ingestion path (spec §6.2 Step 5).
 *
 * Every other extractor is platform-specific and fails closed: yt-dlp knows
 * about video sites, oEmbed knows about two of them, and a plain HTTP GET gets
 * an empty document from anything that renders client-side. Instagram in
 * particular returns *no* OpenGraph tags at all to a signed-out fetch, so the
 * old pipeline had literally nothing to analyse and reported "no readable text".
 *
 * A real browser is the one thing that sees what a person sees. We render the
 * page, screenshot it, and let the vision model read the result — which works
 * uniformly for a Reel, an X post, a recipe, a screenshot or an article,
 * without a bespoke adapter per platform.
 *
 * Login walls are detected rather than screenshotted blindly, so the caller can
 * ask the user to connect that account instead of feeding the model a picture
 * of a sign-in form and calling it an insight.
 */

export interface BrowserCapture {
  /** Visible text of the rendered page. */
  text: string | null;
  /** Screenshot files, in order, for the vision model to read. */
  screenshots: string[];
  /** True when the page is gated behind a sign-in. */
  loginWall: boolean;
  /** Which host is asking for a login, when we can tell. */
  loginHost?: string | null;
  title?: string | null;
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

/** Phrases that mean "you are looking at a gate, not the content". */
const LOGIN_MARKERS = [
  'log in to instagram',
  'log into instagram',
  'sign up to see',
  'see this content',
  'log in to see',
  'this account is private',
  'sign in to confirm',
  'you must log in',
  'please log in',
  'create an account to',
];

/** True when the rendered text looks like a sign-in gate rather than content. */
export function looksLikeLoginWall(text: string, finalUrl: string): boolean {
  const lower = text.toLowerCase().slice(0, 4000);
  if (/\/accounts\/login|\/login\?|\/signin|\/auth\/login/i.test(finalUrl)) return true;
  const hits = LOGIN_MARKERS.filter((marker) => lower.includes(marker)).length;
  // A short page that is mostly a login prompt, rather than an article that
  // happens to mention logging in somewhere near the bottom.
  return hits > 0 && lower.length < 2500;
}

interface PageLike {
  goto(url: string, opts?: unknown): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  keyboard: { press(key: string): Promise<void> };
}

/**
 * Renders a URL and captures what a reader would actually see.
 *
 * `cookiesFromBrowser` is not handled here — Playwright cannot read another
 * browser's cookie jar. Authenticated capture uses a persisted storage state
 * written by the connect-account flow; see `storageStatePath`.
 */
export async function capturePage(options: {
  url: string;
  workDir: string;
  /** Playwright storageState JSON from a completed sign-in, when we have one. */
  storageStatePath?: string | null;
  /** How many viewport screenshots to take while scrolling. */
  maxShots?: number;
}): Promise<BrowserCapture | null> {
  const empty: BrowserCapture = { text: null, screenshots: [], loginWall: false };

  // Indirected so TypeScript does not require Playwright's types at build time;
  // it stays an optional dependency and the caller degrades if it is absent.
  const specifier = 'playwright';
  const playwright = (await import(specifier).catch(() => null)) as {
    chromium: { launch(opts?: unknown): Promise<BrowserLike> };
  } | null;

  if (!playwright) {
    log.warn('browser capture requested but playwright is not installed', {
      hint: 'npm i playwright && npx playwright install chromium',
    });
    return null;
  }

  const shotsDir = path.join(options.workDir, 'shots');
  await fs.mkdir(shotsDir, { recursive: true });

  let browser: BrowserLike | null = null;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const contextOptions: Record<string, unknown> = {
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 1600 },
      deviceScaleFactor: 2, // legible overlay text for OCR
      locale: 'en-US',
    };
    if (options.storageStatePath) contextOptions['storageState'] = options.storageStatePath;

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // Client-rendered feeds need a beat to paint before anything is worth reading.
    await page.waitForTimeout(3500);

    // Dismiss the cookie/consent overlays that otherwise dominate the shot.
    await page
      .evaluate(
        `(() => {
          const wanted = ['accept', 'allow all', 'agree', 'got it', 'only allow essential', 'decline optional'];
          for (const el of Array.from(document.querySelectorAll('button, [role="button"]'))) {
            const label = (el.textContent || '').trim().toLowerCase();
            if (label && wanted.some((w) => label === w || label.startsWith(w))) { el.click(); return true; }
          }
          return false;
        })()`,
      )
      .catch(() => false);
    await page.waitForTimeout(600);

    const rawText = (await page.evaluate('document.body ? document.body.innerText : ""').catch(() => '')) as string;
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    const finalUrl = page.url();
    const title = await page.title().catch(() => null);

    if (looksLikeLoginWall(text, finalUrl)) {
      log.info('login wall detected', { url: options.url, finalUrl });
      // Still capture one shot: it is useful evidence in the run log, and the
      // review screen shows the user exactly what the app hit.
      const shot = path.join(shotsDir, 'login-wall.jpg');
      await page.screenshot({ path: shot }).catch(() => undefined);
      return {
        text: text || null,
        screenshots: [],
        loginWall: true,
        loginHost: safeHost(finalUrl),
        title,
      };
    }

    // Scroll-and-shoot: one viewport at a time, so a long article or a
    // multi-image carousel is covered rather than just the hero.
    const screenshots: string[] = [];
    const maxShots = options.maxShots ?? 4;
    for (let index = 0; index < maxShots; index++) {
      const shot = path.join(shotsDir, `shot-${String(index + 1).padStart(2, '0')}.jpg`);
      await page.screenshot({ path: shot });
      screenshots.push(shot);

      const moved = (await page
        .evaluate(
          `(() => { const before = window.scrollY; window.scrollBy(0, Math.round(window.innerHeight * 0.9)); return window.scrollY !== before; })()`,
        )
        .catch(() => false)) as boolean;
      if (!moved) break;
      await page.waitForTimeout(900);
    }

    log.info('browser capture complete', {
      url: options.url,
      chars: text.length,
      screenshots: screenshots.length,
      authenticated: Boolean(options.storageStatePath),
    });

    return {
      text: text.length > 40 ? text.slice(0, 20_000) : null,
      screenshots,
      loginWall: false,
      title,
    };
  } catch (err) {
    log.warn('browser capture failed', { url: options.url, error: errorMessage(err) });
    return empty;
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

interface BrowserLike {
  newContext(opts?: unknown): Promise<{ newPage(): Promise<PageLike> }>;
  close(): Promise<void>;
}
