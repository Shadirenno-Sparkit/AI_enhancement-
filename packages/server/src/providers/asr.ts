import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger, errorMessage } from '../util/logger.js';

const log = createLogger('asr');

export interface AsrSegment {
  startSec: number;
  endSec: number;
  text: string;
}

export interface AsrResult {
  text: string;
  segments: AsrSegment[];
  language: string;
  durationSec: number;
  /** 0–1 estimate used for the low-confidence flag (BR-U5). */
  confidence: number;
  provider: string;
}

export interface AsrProvider {
  readonly name: string;
  readonly live: boolean;
  transcribe(audioPath: string): Promise<AsrResult | null>;
}

/** Per-minute prices used for budget accounting only. Spec §6.2 Step 3. */
const PRICE_PER_MINUTE: Record<string, number> = {
  openai: 0.006,
  'whisper-local': 0,
  assemblyai: 0.0062,
  deepgram: 0.0043,
  stub: 0,
};

export function asrCostUsd(providerName: string, seconds: number): number {
  const rate = PRICE_PER_MINUTE[providerName] ?? 0.006;
  return (seconds / 60) * rate;
}

/** Nothing to transcribe — used when no key is configured. */
class StubAsrProvider implements AsrProvider {
  readonly name = 'stub';
  readonly live = false;
  async transcribe(): Promise<AsrResult | null> {
    return null;
  }
}

/** OpenAI-compatible /audio/transcriptions (Whisper large-v3 class). */
class OpenAiAsrProvider implements AsrProvider {
  readonly name = 'openai';
  readonly live = true;
  constructor(private apiKey: string) {}

  async transcribe(audioPath: string): Promise<AsrResult | null> {
    const buffer = await fs.readFile(audioPath);
    const form = new FormData();
    form.append('file', new Blob([buffer]), path.basename(audioPath));
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!response.ok) {
      log.error('transcription request failed', { status: response.status });
      return null;
    }
    const body = (await response.json()) as {
      text: string;
      language?: string;
      duration?: number;
      segments?: { start: number; end: number; text: string; no_speech_prob?: number }[];
    };

    const segments: AsrSegment[] = (body.segments ?? []).map((s) => ({
      startSec: s.start,
      endSec: s.end,
      text: s.text.trim(),
    }));
    const noSpeech = (body.segments ?? []).map((s) => s.no_speech_prob ?? 0);
    const avgNoSpeech = noSpeech.length ? noSpeech.reduce((a, b) => a + b, 0) / noSpeech.length : 0.1;

    return {
      text: body.text.trim(),
      segments,
      language: body.language ?? 'en',
      durationSec: body.duration ?? segments.at(-1)?.endSec ?? 0,
      confidence: Math.max(0.5, 1 - avgNoSpeech),
      provider: this.name,
    };
  }
}

/** Local whisper.cpp / faster-whisper CLI producing a JSON sidecar. */
class LocalWhisperProvider implements AsrProvider {
  readonly name = 'whisper-local';
  readonly live = true;

  async transcribe(audioPath: string): Promise<AsrResult | null> {
    const cfg = config();
    const outDir = path.dirname(audioPath);
    const code = await run(cfg.whisperBin, [
      audioPath,
      '--model',
      cfg.whisperModel,
      '--output_format',
      'json',
      '--output_dir',
      outDir,
    ]);
    if (code !== 0) return null;

    const jsonPath = path.join(outDir, `${path.basename(audioPath, path.extname(audioPath))}.json`);
    try {
      const raw = JSON.parse(await fs.readFile(jsonPath, 'utf8')) as {
        text: string;
        language?: string;
        segments?: { start: number; end: number; text: string }[];
      };
      const segments: AsrSegment[] = (raw.segments ?? []).map((s) => ({
        startSec: s.start,
        endSec: s.end,
        text: s.text.trim(),
      }));
      return {
        text: raw.text.trim(),
        segments,
        language: raw.language ?? 'en',
        durationSec: segments.at(-1)?.endSec ?? 0,
        confidence: 0.85,
        provider: this.name,
      };
    } catch (err) {
      log.error('could not read local whisper output', { error: errorMessage(err) });
      return null;
    }
  }
}

/** AssemblyAI Universal — chosen when hallucination rate matters most. */
class AssemblyAiProvider implements AsrProvider {
  readonly name = 'assemblyai';
  readonly live = true;
  constructor(private apiKey: string) {}

  async transcribe(audioPath: string): Promise<AsrResult | null> {
    const buffer = await fs.readFile(audioPath);
    const upload = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { authorization: this.apiKey },
      body: buffer,
    });
    if (!upload.ok) return null;
    const { upload_url: uploadUrl } = (await upload.json()) as { upload_url: string };

    const created = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { authorization: this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: uploadUrl }),
    });
    if (!created.ok) return null;
    const { id: transcriptId } = (await created.json()) as { id: string };

    // Poll to completion; short-form clips finish in well under the ceiling.
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptId}`, {
        headers: { authorization: this.apiKey },
      });
      if (!poll.ok) return null;
      const body = (await poll.json()) as {
        status: string;
        text?: string;
        confidence?: number;
        audio_duration?: number;
        words?: { start: number; end: number; text: string }[];
      };
      if (body.status === 'error') return null;
      if (body.status !== 'completed') continue;

      const segments: AsrSegment[] = (body.words ?? []).map((w) => ({
        startSec: w.start / 1000,
        endSec: w.end / 1000,
        text: w.text,
      }));
      return {
        text: (body.text ?? '').trim(),
        segments,
        language: 'en',
        durationSec: body.audio_duration ?? 0,
        confidence: body.confidence ?? 0.9,
        provider: this.name,
      };
    }
    return null;
  }
}

/** Deepgram Nova-3 — chosen for speed on noisy audio. */
class DeepgramProvider implements AsrProvider {
  readonly name = 'deepgram';
  readonly live = true;
  constructor(private apiKey: string) {}

  async transcribe(audioPath: string): Promise<AsrResult | null> {
    const buffer = await fs.readFile(audioPath);
    const response = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true', {
      method: 'POST',
      headers: { Authorization: `Token ${this.apiKey}`, 'Content-Type': 'audio/mpeg' },
      body: buffer,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      metadata?: { duration?: number };
      results?: {
        channels?: {
          alternatives?: {
            transcript?: string;
            confidence?: number;
            words?: { start: number; end: number; word: string }[];
          }[];
        }[];
      };
    };
    const alt = body.results?.channels?.[0]?.alternatives?.[0];
    if (!alt?.transcript) return null;
    return {
      text: alt.transcript.trim(),
      segments: (alt.words ?? []).map((w) => ({ startSec: w.start, endSec: w.end, text: w.word })),
      language: 'en',
      durationSec: body.metadata?.duration ?? 0,
      confidence: alt.confidence ?? 0.88,
      provider: this.name,
    };
  }
}

function run(bin: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: 'ignore' });
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? -1));
  });
}

let cached: AsrProvider | null = null;

export function asr(): AsrProvider {
  if (cached) return cached;
  const cfg = config();
  switch (cfg.asrProvider) {
    case 'openai':
      cached = cfg.openaiApiKey ? new OpenAiAsrProvider(cfg.openaiApiKey) : new StubAsrProvider();
      break;
    case 'whisper-local':
      cached = new LocalWhisperProvider();
      break;
    case 'assemblyai':
      cached = cfg.assemblyAiApiKey ? new AssemblyAiProvider(cfg.assemblyAiApiKey) : new StubAsrProvider();
      break;
    case 'deepgram':
      cached = cfg.deepgramApiKey ? new DeepgramProvider(cfg.deepgramApiKey) : new StubAsrProvider();
      break;
    default:
      cached = new StubAsrProvider();
  }
  if (!cached.live) log.warn('speech-to-text is not configured — the ASR step will be skipped');
  return cached;
}

export function resetAsr(): void {
  cached = null;
}

export function setAsrForTesting(provider: AsrProvider | null): void {
  cached = provider;
}
