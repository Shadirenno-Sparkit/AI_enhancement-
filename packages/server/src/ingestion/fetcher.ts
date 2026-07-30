import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Platform } from '@aiapp/shared';
import { config } from '../config.js';
import { createLogger, errorMessage } from '../util/logger.js';

const log = createLogger('fetch');

export interface FetchedMedia {
  /** Post title, when the platform exposes one. */
  title?: string | null;
  /** The post's own caption/description — free, and often carries the actual tip. */
  description?: string | null;
  author?: string | null;
  durationSec?: number | null;
  /** Subtitle tracks written to disk, best-first. */
  subtitleFiles: { filePath: string; language: string; auto: boolean }[];
  /** Audio-only download, present when ASR is needed. */
  audioPath?: string | null;
  /** Sampled video frames or carousel images, in order. */
  imagePaths: string[];
  /** Visible text scraped from a rendered page, when the browser agent ran. */
  domText?: string | null;
  /** Which methods actually produced something, for the run log. */
  methods: string[];
  /** True when the platform refused or the content is not publicly reachable. */
  inaccessible?: boolean;
  inaccessibleReason?: string | null;
}

export interface FetchOptions {
  url: string;
  platform: Platform;
  workDir: string;
  /** Skip the audio download when the caller already has good caption text. */
  needAudio: boolean;
  /** Skip frame sampling when on-screen text is unlikely to matter. */
  needFrames: boolean;
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

/** Cap on any single fetch so one bad link cannot stall a worker. */
const FETCH_TIMEOUT_MS = 20_000;
const YTDLP_TIMEOUT_MS = 120_000;

/**
 * Retrieves the least-intrusive representation of a post that will do
 * (spec §5.6, §6.2).
 *
 * Order of preference: platform metadata (free) → author subtitles → auto
 * captions → audio for ASR → frames for OCR → rendered DOM. Every step is
 * optional; whatever succeeds is merged downstream by the normalizer.
 *
 * ToS posture: this only requests representations the platform serves to a
 * signed-out user, and never attempts to defeat a paywall, DRM, private-account
 * gate or rate limit (BRD §13, spec §6.5).
 */
export async function fetchMedia(options: FetchOptions): Promise<FetchedMedia> {
  await fs.mkdir(options.workDir, { recursive: true });

  const result: FetchedMedia = { subtitleFiles: [], imagePaths: [], methods: [] };

  // Step 0 — free metadata. oEmbed and OpenGraph both work without credentials
  // and give us title/description immediately.
  const meta = await fetchMetadata(options.url, options.platform);
  if (meta) {
    result.title = meta.title;
    result.description = meta.description;
    result.author = meta.author;
    if (meta.thumbnailUrl) {
      const thumb = await downloadTo(meta.thumbnailUrl, path.join(options.workDir, 'thumbnail.jpg'));
      if (thumb) result.imagePaths.push(thumb);
    }
    result.methods.push('metadata');
  }

  // Steps 1–3 — yt-dlp handles subtitles, auto-captions and audio in one tool
  // and is the cleanest reliable caption path today (spec §6.2 Step 1).
  if (await hasBinary(config().ytdlpBin)) {
    const yt = await runYtDlp(options);
    if (yt) {
      result.title ??= yt.title;
      result.description ??= yt.description;
      result.author ??= yt.author;
      result.durationSec = yt.durationSec ?? result.durationSec;
      result.subtitleFiles.push(...yt.subtitleFiles);
      if (yt.audioPath) result.audioPath = yt.audioPath;
      if (yt.subtitleFiles.length > 0) result.methods.push('yt-dlp:subtitles');
      if (yt.audioPath) result.methods.push('yt-dlp:audio');
      if (yt.inaccessible) {
        result.inaccessible = true;
        result.inaccessibleReason = yt.inaccessibleReason;
      }
    }
  } else {
    log.debug('yt-dlp not on PATH — using metadata and page-text paths only');
  }

  // Step 4 — frames for OCR. With ffmpeg present we sample the video; otherwise
  // the thumbnail and any carousel images already collected stand in.
  if (options.needFrames && result.audioPath === undefined && result.imagePaths.length === 0) {
    const frames = await sampleFrames(options.workDir, path.join(options.workDir, 'video.mp4'));
    if (frames.length > 0) {
      result.imagePaths.push(...frames);
      result.methods.push('ffmpeg:frames');
    }
  }

  // Step 5 — rendered DOM, last resort for JS-heavy pages.
  if (needsBrowser(result) && config().enableBrowserAgent) {
    const dom = await renderPageText(options.url);
    if (dom) {
      result.domText = dom;
      result.methods.push('browser:dom');
    }
  }

  // Always try plain HTML: for X threads and LinkedIn text posts the advice
  // frequently lives in the markup, and this costs one cheap request.
  if (!result.domText && needsBrowser(result)) {
    const html = await fetchPageText(options.url);
    if (html) {
      result.domText = html;
      result.methods.push('http:page-text');
    }
  }

  if (
    !result.description &&
    !result.domText &&
    result.subtitleFiles.length === 0 &&
    !result.audioPath &&
    result.imagePaths.length === 0
  ) {
    result.inaccessible = true;
    result.inaccessibleReason ??=
      'No caption track, audio, images or readable page text could be retrieved for this link.';
  }

  return result;
}

function needsBrowser(result: FetchedMedia): boolean {
  const haveText = Boolean(result.description && result.description.length > 120);
  return !haveText && result.subtitleFiles.length === 0;
}

// ─── Metadata ────────────────────────────────────────────────────────────────

interface Metadata {
  title?: string | null;
  description?: string | null;
  author?: string | null;
  thumbnailUrl?: string | null;
}

const OEMBED_ENDPOINTS: Partial<Record<Platform, (url: string) => string>> = {
  youtube: (url) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
  tiktok: (url) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
};

async function fetchMetadata(url: string, platform: Platform): Promise<Metadata | null> {
  const oembed = OEMBED_ENDPOINTS[platform];
  if (oembed) {
    const data = await getJson<{
      title?: string;
      author_name?: string;
      thumbnail_url?: string;
      description?: string;
    }>(oembed(url));
    if (data) {
      return {
        title: data.title ?? null,
        author: data.author_name ?? null,
        thumbnailUrl: data.thumbnail_url ?? null,
        description: data.description ?? null,
      };
    }
  }
  return fetchOpenGraph(url);
}

/** OpenGraph tags are served by every mainstream platform to signed-out clients. */
async function fetchOpenGraph(url: string): Promise<Metadata | null> {
  const html = await getText(url);
  if (!html) return null;
  const meta = (property: string): string | null => {
    const pattern = new RegExp(
      `<meta[^>]+(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`,
      'i',
    );
    const alt = new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`,
      'i',
    );
    const match = html.match(pattern) ?? html.match(alt);
    return match?.[1] ? decodeEntities(match[1]) : null;
  };
  const title = meta('og:title') ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() ?? null;
  const description = meta('og:description') ?? meta('description');
  return {
    title: title ? decodeEntities(title) : null,
    description,
    author: meta('og:site_name') ?? meta('author'),
    thumbnailUrl: meta('og:image'),
  };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

/** Strips markup down to the visible prose of a page. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function fetchPageText(url: string): Promise<string | null> {
  const html = await getText(url);
  if (!html) return null;
  const text = htmlToText(html);
  return text.length > 80 ? text.slice(0, 20_000) : null;
}

// ─── yt-dlp ──────────────────────────────────────────────────────────────────

interface YtDlpResult {
  title?: string | null;
  description?: string | null;
  author?: string | null;
  durationSec?: number | null;
  subtitleFiles: { filePath: string; language: string; auto: boolean }[];
  audioPath?: string | null;
  inaccessible?: boolean;
  inaccessibleReason?: string | null;
}

async function runYtDlp(options: FetchOptions): Promise<YtDlpResult | null> {
  const cfg = config();
  const out: YtDlpResult = { subtitleFiles: [] };

  // Pass 1 — metadata plus subtitle tracks, no media download. This is the
  // cheap, high-fidelity path that succeeds for most YouTube links.
  const subsResult = await runCommand(
    cfg.ytdlpBin,
    [
      '--skip-download',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      'en.*,en',
      '--sub-format',
      'vtt',
      '--write-info-json',
      '--no-warnings',
      '--no-playlist',
      '--ignore-config',
      '-o',
      path.join(options.workDir, 'media.%(ext)s'),
      options.url,
    ],
    YTDLP_TIMEOUT_MS,
  );

  if (subsResult.code !== 0) {
    const stderr = subsResult.stderr.toLowerCase();
    // Distinguish "we're not allowed to see this" from a transient failure so
    // BR-U7 can tell the user plainly instead of retrying forever.
    if (
      stderr.includes('private') ||
      stderr.includes('login required') ||
      stderr.includes('sign in') ||
      stderr.includes('members-only') ||
      stderr.includes('not available')
    ) {
      out.inaccessible = true;
      out.inaccessibleReason =
        'This post is private, age-restricted or otherwise not viewable without signing in, so it could not be retrieved.';
      return out;
    }
    log.debug('yt-dlp subtitle pass did not succeed', { stderr: subsResult.stderr.slice(0, 300) });
  }

  const entries = await fs.readdir(options.workDir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (entry.endsWith('.info.json')) {
      try {
        const info = JSON.parse(await fs.readFile(path.join(options.workDir, entry), 'utf8')) as {
          title?: string;
          description?: string;
          uploader?: string;
          channel?: string;
          duration?: number;
        };
        out.title = info.title ?? null;
        out.description = info.description ?? null;
        out.author = info.uploader ?? info.channel ?? null;
        out.durationSec = info.duration ?? null;
      } catch {
        // A malformed info.json is not fatal — the subtitle files still count.
      }
    }
    if (entry.endsWith('.vtt') || entry.endsWith('.srt')) {
      // yt-dlp marks machine captions in the filename, e.g. media.en-orig.vtt
      // vs media.en.vtt; auto-captions carry lower confidence downstream.
      const auto = /\.(auto|orig)\b/i.test(entry) || subsResult.stdout.includes('Writing video automatic subtitles');
      const lang = entry.match(/\.([a-z]{2}(?:-[A-Za-z0-9]+)?)\.(?:vtt|srt)$/)?.[1] ?? 'en';
      out.subtitleFiles.push({ filePath: path.join(options.workDir, entry), language: lang, auto });
    }
  }
  // Author-provided tracks first — they are near-perfect (spec §6.2 Step 1).
  out.subtitleFiles.sort((a, b) => Number(a.auto) - Number(b.auto));

  // Pass 2 — audio only, and only when captions did not already give us text.
  if (options.needAudio && out.subtitleFiles.length === 0 && !out.inaccessible) {
    const audioResult = await runCommand(
      cfg.ytdlpBin,
      [
        '-f',
        'bestaudio/best',
        '-x',
        '--audio-format',
        'mp3',
        '--no-warnings',
        '--no-playlist',
        '--ignore-config',
        '-o',
        path.join(options.workDir, 'audio.%(ext)s'),
        options.url,
      ],
      YTDLP_TIMEOUT_MS,
    );
    if (audioResult.code === 0) {
      const after = await fs.readdir(options.workDir).catch(() => [] as string[]);
      const audio = after.find((f) => f.startsWith('audio.') && /\.(mp3|m4a|opus|webm|wav)$/.test(f));
      if (audio) out.audioPath = path.join(options.workDir, audio);
    }
  }

  return out;
}

// ─── Frames ──────────────────────────────────────────────────────────────────

/**
 * Samples one frame every few seconds so on-screen captions and slide text get
 * read even when the audio carries nothing (spec §6.2 Step 4).
 */
async function sampleFrames(workDir: string, videoPath: string): Promise<string[]> {
  if (!(await exists(videoPath))) return [];
  if (!(await hasBinary(config().ffmpegBin))) return [];

  const framesDir = path.join(workDir, 'frames');
  await fs.mkdir(framesDir, { recursive: true });
  const result = await runCommand(
    config().ffmpegBin,
    ['-y', '-i', videoPath, '-vf', 'fps=1/3,scale=720:-1', '-frames:v', '12', path.join(framesDir, 'frame-%02d.jpg')],
    60_000,
  );
  if (result.code !== 0) return [];
  const files = (await fs.readdir(framesDir).catch(() => [] as string[]))
    .filter((f) => f.endsWith('.jpg'))
    .sort();
  return files.map((f) => path.join(framesDir, f));
}

// ─── Browser agent ───────────────────────────────────────────────────────────

/**
 * Renders a JS-heavy page and returns its visible text (spec §6.2 Step 5).
 *
 * Playwright is an optional dependency: when it is not installed the caller
 * silently falls back to the plain HTTP path rather than failing the job.
 */
async function renderPageText(url: string): Promise<string | null> {
  try {
    // Indirected through a variable so TypeScript does not require Playwright's
    // types to be installed — it is an opt-in extra, not a dependency.
    const specifier = 'playwright';
    const playwright = (await import(specifier).catch(() => null)) as
      | { chromium: { launch(opts?: unknown): Promise<BrowserLike> } }
      | null;
    if (!playwright) {
      log.debug('browser agent enabled but playwright is not installed');
      return null;
    }
    const browser = await playwright.chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ userAgent: USER_AGENT });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(2500);
      const text = await page.evaluate('document.body?.innerText ?? ""');
      return typeof text === 'string' && text.trim().length > 40 ? text.trim().slice(0, 20_000) : null;
    } finally {
      await browser.close();
    }
  } catch (err) {
    log.warn('browser render failed', { error: errorMessage(err) });
    return null;
  }
}

interface BrowserLike {
  newContext(opts?: unknown): Promise<{
    newPage(): Promise<{
      goto(url: string, opts?: unknown): Promise<unknown>;
      waitForTimeout(ms: number): Promise<void>;
      evaluate(script: string): Promise<unknown>;
    }>;
  }>;
  close(): Promise<void>;
}

// ─── Low-level helpers ───────────────────────────────────────────────────────

async function getText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch (err) {
    log.debug('page fetch failed', { url, error: errorMessage(err) });
    return null;
  }
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function downloadTo(url: string, destination: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()));
    return destination;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

const binaryCache = new Map<string, boolean>();

export async function hasBinary(bin: string): Promise<boolean> {
  const cachedResult = binaryCache.get(bin);
  if (cachedResult !== undefined) return cachedResult;
  const result = await runCommand(bin, ['--version'], 5000);
  const found = result.code === 0;
  binaryCache.set(bin, found);
  return found;
}

export function clearBinaryCache(): void {
  binaryCache.clear();
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCommand(bin: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 200_000) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 200_000) stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: -1, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ code: -1, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code: code ?? -1, stdout, stderr });
    });
  });
}
