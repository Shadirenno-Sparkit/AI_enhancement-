import fs from 'node:fs/promises';
import type { InsightSegment, Platform, Provenance } from '@aiapp/shared';
import { PROVENANCE_CONFIDENCE } from '@aiapp/shared';
import { config } from '../config.js';
import { asr, asrCostUsd } from '../providers/asr.js';
import { vision } from '../providers/vision.js';
import { createLogger, errorMessage } from '../util/logger.js';
import type { FetchedMedia } from './fetcher.js';
import { htmlToText } from './fetcher.js';
import { cleanCaptionText, cuesToSegments, parseSubtitles, toVtt, type Cue } from './subtitles.js';

const log = createLogger('transcript');

export interface TranscriptResult {
  segments: InsightSegment[];
  language: string;
  durationSec: number | null;
  /** WebVTT text for the 01_transcript.vtt artifact, when time-coded. */
  vtt: string | null;
  methodsUsed: Provenance[];
  cost: { asrSeconds: number; usd: number };
  /** Set when the waterfall exhausted every step without usable text. */
  failureReason?: string | null;
}

/**
 * Runs the extraction waterfall for one link (spec §6.2).
 *
 * The steps are tried cheapest-and-highest-fidelity first, but they are not
 * mutually exclusive: on-screen text (Step 4) runs *alongside* the audio path
 * rather than instead of it, because a post routinely carries the tip in one,
 * the other, or both (spec §6.5 "Parallelize").
 */
export async function runTranscriptWaterfall(input: {
  media: FetchedMedia;
  platform: Platform;
  sharedText?: string | null;
  note?: string | null;
}): Promise<TranscriptResult> {
  const cfg = config();
  const segments: InsightSegment[] = [];
  const methodsUsed: Provenance[] = [];
  const cost = { asrSeconds: 0, usd: 0 };
  let language = 'en';
  let durationSec: number | null = input.media.durationSec ?? null;
  let vtt: string | null = null;
  let order = 0;

  const push = (
    text: string,
    provenance: Provenance,
    extra?: { startSec?: number; frameIndex?: number; confidence?: number },
  ): void => {
    const cleaned = text.trim();
    if (!cleaned) return;
    segments.push({
      order: order++,
      text: cleaned,
      provenance,
      confidence: extra?.confidence ?? PROVENANCE_CONFIDENCE[provenance],
      startSec: extra?.startSec ?? null,
      frameIndex: extra?.frameIndex ?? null,
    });
    if (!methodsUsed.includes(provenance)) methodsUsed.push(provenance);
  };

  // ── Step 0 — the post's own caption/description. Free, and on Instagram and
  // LinkedIn it frequently *is* the tip (spec §6.2 Step 0, BR-U4).
  if (input.media.description) {
    for (const block of splitParagraphs(input.media.description)) {
      push(block, 'post_description');
    }
  }
  if (input.sharedText) {
    // Text the user shared alongside the link — often the caption their app copied.
    const extra = splitParagraphs(input.sharedText).filter(
      (block) => !input.media.description?.includes(block),
    );
    for (const block of extra) push(block, 'post_description');
  }
  if (input.note) push(`User note: ${input.note}`, 'user_note');

  // ── Steps 1–2 — caption tracks. Author-provided first (~99% accurate),
  // machine captions second (~85–95%).
  let captionCues: Cue[] = [];
  for (const track of input.media.subtitleFiles) {
    try {
      const raw = await fs.readFile(track.filePath, 'utf8');
      const cues = cuesToSegments(parseSubtitles(raw));
      if (cues.length === 0) continue;
      captionCues = cues;
      language = track.language.split('-')[0] ?? 'en';
      const provenance: Provenance = track.auto ? 'auto_caption' : 'author_caption';
      for (const cue of cues) push(cue.text, provenance, { startSec: cue.startSec });
      durationSec ??= cues.at(-1)?.endSec ?? null;
      vtt = toVtt(cues);
      break; // The best-ranked track that parsed is the one we use.
    } catch (err) {
      log.warn('subtitle track could not be read', { file: track.filePath, error: errorMessage(err) });
    }
  }

  // ── Step 3 — audio ASR, only when no caption track produced text.
  if (captionCues.length === 0 && input.media.audioPath) {
    const provider = asr();
    if (provider.live) {
      try {
        const result = await provider.transcribe(input.media.audioPath);
        if (result && result.text) {
          if (result.durationSec > cfg.maxAsrSecondsPerLink) {
            log.warn('clip exceeds the per-link ASR ceiling', { durationSec: result.durationSec });
          }
          language = result.language || language;
          durationSec ??= result.durationSec;
          cost.asrSeconds += result.durationSec;
          cost.usd += asrCostUsd(provider.name, result.durationSec);

          const provenance: Provenance = provider.name === 'openai' || provider.name === 'whisper-local'
            ? 'asr_whisper'
            : 'asr_hosted';
          const cues = result.segments.length
            ? cuesToSegments(result.segments.map((s) => ({ startSec: s.startSec, endSec: s.endSec, text: s.text })))
            : [{ startSec: 0, endSec: result.durationSec, text: result.text }];
          for (const cue of cues) {
            push(cue.text, provenance, { startSec: cue.startSec, confidence: result.confidence });
          }
          vtt ??= toVtt(cues);
        }
      } catch (err) {
        log.error('speech-to-text failed', { error: errorMessage(err) });
      }
    }
  }

  // ── Step 4 — visual text. Runs regardless of whether audio produced text.
  if (input.media.imagePaths.length > 0) {
    const provider = vision();
    if (provider.live) {
      try {
        const frames = input.media.imagePaths.map((filePath, index) => ({ index: index + 1, filePath }));
        const { results, usd } = await provider.read(frames);
        cost.usd += usd;
        for (const frame of results.sort((a, b) => a.index - b.index)) {
          if (!frame.text.trim()) continue;
          const provenance: Provenance = frame.provider === 'tesseract' ? 'ocr_tesseract' : 'ocr_multimodal';
          // Slide labelling preserves carousel order in the merged text (use case 9.2).
          const label = input.media.imagePaths.length > 1 ? `SLIDE ${frame.index}: ` : '';
          push(`${label}${frame.text}`, provenance, {
            frameIndex: frame.index,
            confidence: frame.confidence,
          });
        }
      } catch (err) {
        log.error('vision read failed', { error: errorMessage(err) });
      }
    }
  }

  // ── Step 5 — rendered/plain page text, the last resort.
  if (input.media.domText) {
    const text = looksLikeHtml(input.media.domText) ? htmlToText(input.media.domText) : input.media.domText;
    const meaningful = extractMeaningfulLines(text);
    // Only worth including when it adds something the earlier steps missed.
    const existing = segments.map((s) => s.text.toLowerCase()).join(' ');
    for (const block of meaningful) {
      if (existing.includes(block.toLowerCase().slice(0, 60))) continue;
      push(block, 'browser_dom');
    }
  }

  const failureReason = segments.length === 0 ? describeFailure(input.media, input.platform) : null;

  return {
    segments,
    language,
    durationSec,
    vtt,
    methodsUsed,
    cost,
    failureReason,
  };
}

function looksLikeHtml(text: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(text.slice(0, 2000));
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}|\r\n{2,}/)
    .map((block) => cleanCaptionText(block.replace(/\s*\n\s*/g, ' ')))
    .filter((block) => block.length > 2);
}

/**
 * Page text is mostly navigation chrome. Keep lines that read like prose or
 * instructions and drop single-word menu entries and cookie banners.
 */
function extractMeaningfulLines(text: string): string[] {
  const NOISE =
    /^(home|log ?in|sign ?up|sign ?in|menu|search|follow|share|subscribe|cookies?|accept all|privacy|terms|settings|more|see more|download|open app|explore|about|contact|help|©|\d+ (likes?|views?|comments?|shares?))$/i;
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 25 && line.length <= 1200)
    .filter((line) => !NOISE.test(line))
    .filter((line) => /\s/.test(line));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= 60) break;
  }
  return out;
}

/**
 * Plain-language explanation of why nothing could be extracted (BR-U7).
 * The user is told what happened; the system never fabricates content.
 */
function describeFailure(media: FetchedMedia, platform: Platform): string {
  if (media.inaccessible && media.inaccessibleReason) return media.inaccessibleReason;

  const cfg = config();
  const missing: string[] = [];
  if (!asr().live) missing.push('speech-to-text is not configured');
  if (!vision().live) missing.push('vision/OCR is not configured');
  if (!cfg.enableBrowserAgent) missing.push('the browser agent is disabled');

  const base =
    platform === 'instagram' || platform === 'tiktok'
      ? `${platform === 'instagram' ? 'Instagram' : 'TikTok'} posts rarely expose a caption track, so this link needs speech-to-text or on-screen text reading.`
      : 'No caption track, audio, on-screen text or readable page text could be retrieved for this link.';

  return missing.length > 0
    ? `${base} Nothing was extracted because ${missing.join(', ')}. Add the relevant provider keys and re-run this link to try again.`
    : `${base} Nothing usable was extracted, so no spec was written for it.`;
}
