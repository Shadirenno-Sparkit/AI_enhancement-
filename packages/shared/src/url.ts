import type { Platform } from './types.js';

/**
 * Tracking parameters that change per share but not per content. Stripping them
 * is what makes `hash(userId + normalizedUrl)` a usable idempotency key
 * (spec §5.3) — otherwise the same Reel shared twice looks like two links.
 */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'igshid',
  'igsh',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'si',
  'feature',
  'app',
  'ref',
  'ref_src',
  'ref_url',
  's',
  'is_from_webapp',
  'sender_device',
  'web_id',
  'rdid',
  '_r',
  '_d',
  'share_app_id',
  'share_link_id',
  'trk',
  'originalSubdomain',
]);

const HOST_ALIASES: Record<string, string> = {
  'youtu.be': 'www.youtube.com',
  'm.youtube.com': 'www.youtube.com',
  'youtube.com': 'www.youtube.com',
  'music.youtube.com': 'www.youtube.com',
  'm.facebook.com': 'www.facebook.com',
  'facebook.com': 'www.facebook.com',
  'fb.watch': 'www.facebook.com',
  'instagram.com': 'www.instagram.com',
  'm.tiktok.com': 'www.tiktok.com',
  'vm.tiktok.com': 'www.tiktok.com',
  'tiktok.com': 'www.tiktok.com',
  'twitter.com': 'x.com',
  'mobile.twitter.com': 'x.com',
  'www.twitter.com': 'x.com',
  'www.x.com': 'x.com',
  'linkedin.com': 'www.linkedin.com',
  'lnkd.in': 'www.linkedin.com',
};

/**
 * Pulls the first http(s) URL out of arbitrary shared text.
 *
 * Both capture clients need this: the Web Share Target API on Android routinely
 * delivers the URL inside the `text` field rather than `url` (spec §4.1), and
 * iOS share extensions often hand over "Caption text… https://link".
 */
export function extractUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const match = input.match(/https?:\/\/[^\s<>"')\]]+/i);
  if (!match) return null;
  // Trim trailing punctuation that belongs to the surrounding sentence.
  return match[0].replace(/[.,;:!?)\]}'"]+$/, '');
}

/** Everything in the shared payload that is not the URL becomes context text. */
export function stripUrl(input: string | null | undefined, url: string): string {
  if (!input) return '';
  return input.replace(url, '').replace(/\s+/g, ' ').trim();
}

/**
 * Canonical form of a URL for dedupe and content-hash caching.
 * Lower-cases the host, applies known aliases, drops tracking params, expands
 * youtu.be short links, and removes trailing slashes and fragments.
 */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim().toLowerCase();
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw.trim().toLowerCase();
  u.protocol = 'https:';

  const originalHost = u.hostname.toLowerCase();
  const host = HOST_ALIASES[originalHost] ?? originalHost;

  // youtu.be/<id> and fb.watch/<id> carry the id in the path.
  if (originalHost === 'youtu.be') {
    const id = u.pathname.replace(/^\//, '').split('/')[0];
    if (id) {
      u.pathname = '/watch';
      u.search = `?v=${id}`;
    }
  }
  u.hostname = host;
  u.hash = '';
  u.port = '';

  // YouTube /shorts/<id> and /watch?v=<id> are the same video.
  const shorts = u.pathname.match(/^\/shorts\/([\w-]+)/);
  if (host === 'www.youtube.com' && shorts?.[1]) {
    u.pathname = '/watch';
    u.search = `?v=${shorts[1]}`;
  }

  const params = new URLSearchParams(u.search);
  for (const key of [...params.keys()]) {
    if (TRACKING_PARAMS.has(key) || key.startsWith('utm_')) params.delete(key);
  }
  params.sort();
  const query = params.toString();
  u.search = query ? `?${query}` : '';

  let out = u.toString();
  if (out.endsWith('/') && u.pathname !== '/') out = out.slice(0, -1);
  return out;
}

/** Classifies a URL into a platform strategy profile. Spec §5.5. */
export function resolvePlatform(rawUrl: string): Platform {
  let host: string;
  try {
    host = new URL(normalizeUrl(rawUrl)).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if (host.endsWith('youtube.com') || host === 'youtu.be') return 'youtube';
  if (host.endsWith('instagram.com')) return 'instagram';
  if (host.endsWith('tiktok.com')) return 'tiktok';
  if (host === 'x.com' || host.endsWith('.x.com') || host.endsWith('twitter.com')) return 'x';
  if (host.endsWith('linkedin.com') || host === 'lnkd.in') return 'linkedin';
  if (host.endsWith('facebook.com') || host === 'fb.watch') return 'facebook';
  return 'other';
}

/** Human label for a platform, used in folder names and the UI. */
export const PLATFORM_LABELS: Record<Platform, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  x: 'X',
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
  other: 'Web',
};
