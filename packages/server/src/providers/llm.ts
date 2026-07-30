import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { createLogger, errorMessage } from '../util/logger.js';

const log = createLogger('llm');

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface LlmResult<T> {
  value: T;
  usage: LlmUsage;
  /** Which provider actually served the call — surfaced for source transparency. */
  provider: 'claude' | 'offline';
}

export interface LlmImage {
  /** Base64-encoded image data. */
  data: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
}

export interface LlmRequest {
  system: string;
  prompt: string;
  images?: LlmImage[];
  maxTokens?: number;
  /** Use the cheaper model for mechanical work like tidying a transcript. */
  fast?: boolean;
}

/**
 * Published per-million-token prices used only for budget accounting. They are
 * intentionally conservative; real billing is authoritative.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

function priceFor(model: string, inputTokens: number, outputTokens: number): number {
  const table = PRICING[model] ?? { input: 5, output: 25 };
  return (inputTokens / 1_000_000) * table.input + (outputTokens / 1_000_000) * table.output;
}

export interface LlmProvider {
  readonly name: 'claude' | 'offline';
  /** True when calls reach a real model; false for the deterministic analyzer. */
  readonly live: boolean;
  complete(request: LlmRequest): Promise<LlmResult<string>>;
}

class ClaudeProvider implements LlmProvider {
  readonly name = 'claude' as const;
  readonly live = true;
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 3 });
  }

  async complete(request: LlmRequest): Promise<LlmResult<string>> {
    const cfg = config();
    const model = request.fast ? cfg.anthropicFastModel : cfg.anthropicModel;

    const content: Anthropic.ContentBlockParam[] = [];
    for (const image of request.images ?? []) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.data },
      });
    }
    content.push({ type: 'text', text: request.prompt });

    const response = await this.client.messages.create({
      model,
      max_tokens: request.maxTokens ?? 4096,
      system: request.system,
      messages: [{ role: 'user', content }],
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    return {
      value: text,
      provider: 'claude',
      usage: { inputTokens, outputTokens, usd: priceFor(model, inputTokens, outputTokens) },
    };
  }
}

/**
 * Deterministic offline provider.
 *
 * This is not a mock in the testing sense — it is the reason the product works
 * out of the box. With no ANTHROPIC_API_KEY, the analysis layer falls back to
 * rule-based extraction (see analysis/heuristics.ts) and this provider simply
 * reports that no model was reachable, so the pipeline completes with honest,
 * grounded output instead of failing or inventing advice.
 */
class OfflineProvider implements LlmProvider {
  readonly name = 'offline' as const;
  readonly live = false;

  async complete(): Promise<LlmResult<string>> {
    return {
      value: '',
      provider: 'offline',
      usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
    };
  }
}

let cached: LlmProvider | null = null;

export function llm(): LlmProvider {
  if (cached) return cached;
  const key = config().anthropicApiKey;
  if (key) {
    log.info('using Claude for analysis and implementation', { model: config().anthropicModel });
    cached = new ClaudeProvider(key);
  } else {
    log.warn('ANTHROPIC_API_KEY not set — using the offline deterministic analyzer');
    cached = new OfflineProvider();
  }
  return cached;
}

export function resetLlm(): void {
  cached = null;
}

export function setLlmForTesting(provider: LlmProvider | null): void {
  cached = provider;
}

/**
 * Runs a completion that must return JSON, tolerating the usual model habits
 * (fenced blocks, a sentence of preamble). Returns null rather than throwing so
 * callers can fall back to the heuristic path.
 */
export async function completeJson<T>(request: LlmRequest): Promise<LlmResult<T> | null> {
  const provider = llm();
  if (!provider.live) return null;
  try {
    const result = await provider.complete(request);
    const parsed = parseJsonLoose<T>(result.value);
    if (parsed === null) {
      log.warn('model response was not parseable as JSON', { preview: result.value.slice(0, 200) });
      return null;
    }
    return { value: parsed, usage: result.usage, provider: result.provider };
  } catch (err) {
    log.error('model call failed', { error: errorMessage(err) });
    return null;
  }
}

export function parseJsonLoose<T>(text: string): T | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());

  // Last resort: the widest brace/bracket span in the response.
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
