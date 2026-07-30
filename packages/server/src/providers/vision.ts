import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger, errorMessage } from '../util/logger.js';
import { llm, type LlmImage } from './llm.js';

const log = createLogger('vision');

export interface VisionFrame {
  /** Slide number for a carousel, or sampled-frame index for a video. */
  index: number;
  filePath: string;
}

export interface VisionReadResult {
  index: number;
  /** Ordered text read off the image, including stylized/overlaid text. */
  text: string;
  confidence: number;
  provider: string;
}

export interface VisionProvider {
  readonly name: string;
  readonly live: boolean;
  read(frames: VisionFrame[]): Promise<{ results: VisionReadResult[]; usd: number }>;
}

class StubVisionProvider implements VisionProvider {
  readonly name = 'stub';
  readonly live = false;
  async read(): Promise<{ results: VisionReadResult[]; usd: number }> {
    return { results: [], usd: 0 };
  }
}

const MEDIA_TYPES: Record<string, LlmImage['mediaType']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/**
 * Multimodal read: OCR and comprehension in one pass (spec §6.2 Step 4).
 *
 * Handles the very common "advice baked onto a slide" case that a plain OCR
 * engine reads as disconnected words — the model preserves reading order across
 * stylized layouts and tells us when a frame carries no text at all.
 */
class ClaudeVisionProvider implements VisionProvider {
  readonly name = 'claude';
  readonly live = true;

  async read(frames: VisionFrame[]): Promise<{ results: VisionReadResult[]; usd: number }> {
    const results: VisionReadResult[] = [];
    let usd = 0;

    // Batched a few frames at a time: enough context to keep carousel ordering
    // coherent, small enough to stay inside a sane per-request token budget.
    const BATCH = 4;
    for (let start = 0; start < frames.length; start += BATCH) {
      const batch = frames.slice(start, start + BATCH);
      const images: LlmImage[] = [];
      for (const frame of batch) {
        const ext = path.extname(frame.filePath).toLowerCase();
        const mediaType = MEDIA_TYPES[ext];
        if (!mediaType) continue;
        try {
          images.push({ data: (await fs.readFile(frame.filePath)).toString('base64'), mediaType });
        } catch (err) {
          log.warn('could not read frame', { file: frame.filePath, error: errorMessage(err) });
        }
      }
      if (images.length === 0) continue;

      const indices = batch.map((f) => f.index);
      try {
        const response = await llm().complete({
          system:
            'You transcribe text that appears visually in images from social media posts. ' +
            'Report exactly what is written, in reading order, preserving line breaks between distinct lines. ' +
            'Do not summarize, do not interpret, and never invent text that is not visibly present. ' +
            'If an image contains no readable text, return an empty string for it.',
          prompt:
            `These are images ${indices.join(', ')} from a single post, in order.\n\n` +
            'Return JSON only, shaped as:\n' +
            '{"frames":[{"index":<the image number>,"text":"<verbatim visible text>"}]}\n\n' +
            `Use exactly these index values, in this order: ${indices.join(', ')}.`,
          images,
          maxTokens: 2048,
        });
        usd += response.usage.usd;

        const parsed = parseFrames(response.value);
        if (parsed) {
          for (const frame of parsed) {
            if (!indices.includes(frame.index)) continue;
            results.push({
              index: frame.index,
              text: frame.text.trim(),
              confidence: 0.95,
              provider: this.name,
            });
          }
        }
      } catch (err) {
        log.error('multimodal read failed', { error: errorMessage(err) });
      }
    }
    return { results, usd };
  }
}

function parseFrames(text: string): { index: number; text: string }[] | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1]?.trim(), trimmed].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { frames?: { index: number; text: string }[] };
      if (Array.isArray(parsed.frames)) return parsed.frames;
    } catch {
      // try next
    }
  }
  return null;
}

/** Cheap fallback for clean, text-only frames (spec §6.2 Step 4). */
class TesseractProvider implements VisionProvider {
  readonly name = 'tesseract';
  readonly live = true;

  async read(frames: VisionFrame[]): Promise<{ results: VisionReadResult[]; usd: number }> {
    const results: VisionReadResult[] = [];
    for (const frame of frames) {
      const text = await this.runTesseract(frame.filePath);
      if (text && text.trim()) {
        results.push({ index: frame.index, text: text.trim(), confidence: 0.82, provider: this.name });
      }
    }
    return { results, usd: 0 };
  }

  private runTesseract(file: string): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn(config().tesseractBin, [file, 'stdout'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve(code === 0 ? out : null));
    });
  }
}

let cached: VisionProvider | null = null;

export function vision(): VisionProvider {
  if (cached) return cached;
  const cfg = config();
  if (cfg.visionProvider === 'claude' && cfg.anthropicApiKey) cached = new ClaudeVisionProvider();
  else if (cfg.visionProvider === 'tesseract') cached = new TesseractProvider();
  else cached = new StubVisionProvider();

  if (!cached.live) log.warn('vision/OCR is not configured — on-screen text will not be read');
  return cached;
}

export function resetVision(): void {
  cached = null;
}

export function setVisionForTesting(provider: VisionProvider | null): void {
  cached = provider;
}
