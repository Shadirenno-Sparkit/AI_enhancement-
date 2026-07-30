import type { InsightSegment, InsightSource, Provenance } from '@aiapp/shared';
import { cleanCaptionText } from './subtitles.js';

/** Confidence below this, or too little text, flags the result. Spec §6.5. */
const LOW_CONFIDENCE_THRESHOLD = 0.75;
const THIN_TEXT_CHARS = 220;

export interface NormalizedContent {
  segments: InsightSegment[];
  overallConfidence: number;
  lowConfidence: boolean;
  methodsUsed: Provenance[];
  /** Everything merged into one ordered document, ready for the analyzer. */
  mergedText: string;
  /** Plain-text transcript for the 01_transcript.txt artifact. */
  transcriptText: string;
}

/**
 * Merges caption, ASR, on-screen text and post description into one canonical
 * ordered document with provenance and confidence per segment (spec §5.9, §6.2
 * Step 6).
 *
 * Deduplication matters more than it looks: a Reel routinely burns the same
 * sentence into the video, says it aloud, and repeats it in the caption. Left
 * alone, the analyzer sees the tip three times and inflates it into three
 * separate "features".
 */
export function normalize(input: {
  segments: InsightSegment[];
  postDescription?: string | null;
}): NormalizedContent {
  const cleaned = input.segments
    .map((segment) => ({ ...segment, text: cleanCaptionText(segment.text) }))
    .filter((segment) => segment.text.length > 0);

  const deduped = dedupeSegments(cleaned);
  // Re-number after dedupe so `sourceSegments` indices on spec items line up
  // with what actually gets written to 02_extracted-insights.json.
  const ordered = deduped.map((segment, index) => ({ ...segment, order: index }));

  const methodsUsed: Provenance[] = [];
  for (const segment of ordered) {
    if (!methodsUsed.includes(segment.provenance)) methodsUsed.push(segment.provenance);
  }

  const totalChars = ordered.reduce((sum, segment) => sum + segment.text.length, 0);
  // Weight by length: one high-confidence word should not outvote a paragraph.
  const overallConfidence =
    totalChars === 0
      ? 0
      : ordered.reduce((sum, segment) => sum + segment.confidence * segment.text.length, 0) / totalChars;

  /*
   * The low-confidence flag drives a warning banner and a "re-run with a
   * stronger method" offer, so it has to mean something actionable.
   *
   * Thin text on its own does not: a caption we read verbatim is exactly right,
   * the post was just short, and re-running cannot improve it. Thinness only
   * signals a problem when the text came from a lossy path (ASR, OCR, scraped
   * page) where a stronger method genuinely might recover more.
   */
  const VERBATIM: Provenance[] = ['post_description', 'author_caption', 'user_note'];
  const allVerbatim = ordered.length > 0 && ordered.every((segment) => VERBATIM.includes(segment.provenance));

  const lowConfidence =
    ordered.length === 0 ||
    overallConfidence < LOW_CONFIDENCE_THRESHOLD ||
    (totalChars < THIN_TEXT_CHARS && !allVerbatim);

  return {
    segments: ordered,
    overallConfidence: Number(overallConfidence.toFixed(3)),
    lowConfidence,
    methodsUsed,
    mergedText: renderMergedText(ordered),
    transcriptText: renderTranscript(ordered),
  };
}

/**
 * Drops a segment when an earlier segment already carries the same content.
 * Comparison is on a normalized token signature so "Set a standing instruction!"
 * and "set a standing instruction" collapse together.
 */
function dedupeSegments(segments: InsightSegment[]): InsightSegment[] {
  const out: InsightSegment[] = [];
  const seen: { signature: string; index: number }[] = [];

  for (const segment of segments) {
    const signature = signatureOf(segment.text);
    if (signature.length < 12) {
      out.push(segment);
      continue;
    }

    const duplicateAt = seen.findIndex(
      (entry) =>
        entry.signature === signature ||
        entry.signature.includes(signature) ||
        signature.includes(entry.signature),
    );

    if (duplicateAt !== -1) {
      const existingIndex = seen[duplicateAt]!.index;
      const existing = out[existingIndex]!;
      // Keep whichever version we trust more, and remember that we saw both.
      if (segment.confidence > existing.confidence || segment.text.length > existing.text.length * 1.2) {
        out[existingIndex] = { ...segment, order: existing.order };
        seen[duplicateAt] = { signature: signatureOf(segment.text), index: existingIndex };
      }
      continue;
    }

    seen.push({ signature, index: out.length });
    out.push(segment);
  }
  return out;
}

function signatureOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/^slide \d+:\s*/i, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const PROVENANCE_LABELS: Record<Provenance, string> = {
  post_description: 'post caption',
  author_caption: 'author captions',
  auto_caption: 'auto captions',
  asr_whisper: 'speech-to-text',
  asr_hosted: 'speech-to-text',
  ocr_multimodal: 'on-screen text',
  ocr_tesseract: 'on-screen text (OCR)',
  browser_dom: 'page text',
  user_note: 'your note',
};

/**
 * The analyzer's input document. Every line is tagged with where it came from
 * so the model can weight a near-perfect author caption above a shaky OCR read,
 * and so items can cite the segments they were drawn from.
 */
function renderMergedText(segments: InsightSegment[]): string {
  return segments
    .map((segment) => {
      const time =
        segment.startSec !== null && segment.startSec !== undefined
          ? ` @${formatTime(segment.startSec)}`
          : segment.frameIndex
            ? ` @slide ${segment.frameIndex}`
            : '';
      return `[${segment.order}] (${PROVENANCE_LABELS[segment.provenance]}${time}) ${segment.text}`;
    })
    .join('\n');
}

/** Human-readable transcript artifact, without the machine annotations. */
function renderTranscript(segments: InsightSegment[]): string {
  const groups = new Map<Provenance, string[]>();
  for (const segment of segments) {
    const bucket = groups.get(segment.provenance) ?? [];
    bucket.push(segment.text);
    groups.set(segment.provenance, bucket);
  }
  const parts: string[] = [];
  for (const [provenance, texts] of groups) {
    parts.push(`## ${PROVENANCE_LABELS[provenance].replace(/^\w/, (c) => c.toUpperCase())}\n\n${texts.join('\n\n')}`);
  }
  return parts.join('\n\n');
}

function formatTime(seconds: number): string {
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(Math.floor(seconds % 60)).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** Renders the segments of a stored InsightSource back into analyzer input. */
export function mergedTextFor(source: InsightSource): string {
  return renderMergedText(source.segments);
}
