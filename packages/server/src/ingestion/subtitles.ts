export interface Cue {
  startSec: number;
  endSec: number;
  text: string;
}

function parseTimestamp(value: string): number {
  // Accepts both "00:01:02.500" (VTT) and "00:01:02,500" (SRT), with or
  // without the hours component.
  const cleaned = value.trim().replace(',', '.');
  const parts = cleaned.split(':').map(Number);
  if (parts.some((p) => Number.isNaN(p))) return Number.NaN;
  if (parts.length === 3) return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  return parts[0] ?? Number.NaN;
}

const TIMING_LINE = /^([\d:.,]+)\s*-->\s*([\d:.,]+)/;

/**
 * Parses a WebVTT or SRT track into cues.
 *
 * YouTube auto-captions use a rolling-window style where each cue repeats the
 * previous line plus one new one. Left alone that triples the transcript and
 * poisons the analysis, so `dedupeCues` collapses it.
 */
export function parseSubtitles(content: string): Cue[] {
  const lines = content.replace(/\r/g, '').split('\n');
  const cues: Cue[] = [];
  let current: Cue | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    const timing = line.match(TIMING_LINE);
    if (timing?.[1] && timing[2]) {
      if (current && current.text.trim()) cues.push(current);
      const start = parseTimestamp(timing[1]);
      const end = parseTimestamp(timing[2]);
      current = { startSec: Number.isNaN(start) ? 0 : start, endSec: Number.isNaN(end) ? 0 : end, text: '' };
      continue;
    }
    if (!current) continue;
    if (!line) continue;
    if (/^WEBVTT/.test(line) || /^NOTE\b/.test(line) || /^\d+$/.test(line)) continue;

    const text = stripCueMarkup(line);
    if (text) current.text += (current.text ? ' ' : '') + text;
  }
  if (current && current.text.trim()) cues.push(current);

  return dedupeCues(cues);
}

/** Removes inline VTT markup and positioning junk, leaving the spoken words. */
function stripCueMarkup(line: string): string {
  return line
    .replace(/<\/?[cvbi][^>]*>/gi, '')
    .replace(/<\d{2}:\d{2}:\d{2}[.,]\d{3}>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/align:[^\s]+|position:[^\s]+|line:[^\s]+|size:[^\s]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Collapses the rolling-window duplication of auto-captions: when a cue's text
 * is a prefix of, or wholly contained in, the next cue's text, only the longest
 * version survives.
 */
export function dedupeCues(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const cue of cues) {
    const text = cue.text.trim();
    if (!text) continue;
    const previous = out.at(-1);
    if (previous) {
      const a = previous.text.toLowerCase();
      const b = text.toLowerCase();
      if (b.startsWith(a) || b === a) {
        // The newer cue is a superset — replace rather than append.
        previous.text = text;
        previous.endSec = cue.endSec;
        continue;
      }
      if (a.includes(b)) continue;
      // Partial overlap: append only the tail that is genuinely new.
      const overlap = longestOverlap(a, b);
      if (overlap > 12) {
        previous.text = `${previous.text} ${text.slice(overlap)}`.replace(/\s+/g, ' ').trim();
        previous.endSec = cue.endSec;
        continue;
      }
    }
    out.push({ ...cue, text });
  }
  return out;
}

/** Length of the longest suffix of `a` that is also a prefix of `b`. */
function longestOverlap(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  for (let length = max; length > 0; length--) {
    if (a.endsWith(b.slice(0, length))) return length;
  }
  return 0;
}

/** Artifact tokens auto-captions insert that carry no meaning. Spec §5.9. */
const ARTIFACT_TOKENS =
  /\[(music|applause|laughter|inaudible|silence|sound effect|background noise|foreign|__)\]/gi;

export function cleanCaptionText(text: string): string {
  return text
    .replace(ARTIFACT_TOKENS, ' ')
    .replace(/\bum+\b|\buh+\b/gi, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Groups cues into sentence-ish blocks so segments read naturally. */
export function cuesToSegments(cues: Cue[], maxChars = 320): Cue[] {
  const out: Cue[] = [];
  let buffer: Cue | null = null;

  for (const cue of cues) {
    const text = cleanCaptionText(cue.text);
    if (!text) continue;
    if (!buffer) {
      buffer = { startSec: cue.startSec, endSec: cue.endSec, text };
      continue;
    }
    const combined = `${buffer.text} ${text}`.trim();
    const endsSentence = /[.!?]"?$/.test(buffer.text);
    if (combined.length > maxChars || endsSentence) {
      out.push(buffer);
      buffer = { startSec: cue.startSec, endSec: cue.endSec, text };
    } else {
      buffer.text = combined;
      buffer.endSec = cue.endSec;
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

/** Renders cues back to WebVTT for the 01_transcript.vtt artifact. */
export function toVtt(cues: Cue[]): string {
  const stamp = (seconds: number): string => {
    const total = Math.max(0, seconds);
    const hh = String(Math.floor(total / 3600)).padStart(2, '0');
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const ss = String(Math.floor(total % 60)).padStart(2, '0');
    const ms = String(Math.round((total % 1) * 1000)).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  };
  const body = cues
    .map((cue, index) => `${index + 1}\n${stamp(cue.startSec)} --> ${stamp(cue.endSec)}\n${cue.text}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}
