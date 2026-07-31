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
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

function priceFor(model: string, inputTokens: number, outputTokens: number): number {
  const table = PRICING[model] ?? { input: 5, output: 25 };
  return (inputTokens / 1_000_000) * table.input + (outputTokens / 1_000_000) * table.output;
}

/**
 * A capability the model may invoke during an agent run.
 *
 * `run` is the only thing that touches the outside world, and it is never
 * called until `approve` (below) has said yes — that ordering is what makes the
 * trust dial meaningful rather than decorative.
 */
export interface LlmTool {
  name: string;
  /** Tell the model *when* to call this, not just what it does — trigger
   *  conditions in the description measurably improve should-call accuracy. */
  description: string;
  inputSchema: Record<string, unknown>;
  run(input: Record<string, unknown>): Promise<{ content: string; isError?: boolean }>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** What the caller decided about a pending tool call. */
export interface ToolApproval {
  allow: boolean;
  /** Shown to the model when denied, so it can adapt rather than retry blindly. */
  reason?: string;
}

export interface AgentRequest {
  system: string;
  prompt: string;
  tools: LlmTool[];
  maxTokens?: number;
  /** Hard ceiling on model turns, so a confused run cannot loop forever. */
  maxIterations?: number;
  /** Gate invoked before every tool executes. Omit to allow everything. */
  approve?(call: ToolCall): Promise<ToolApproval>;
  /** Called after each tool runs, for the run log and audit trail. */
  onToolResult?(call: ToolCall, result: { content: string; isError?: boolean }, approved: boolean): void;
}

export interface AgentResult {
  /** The model's closing prose, if any. */
  text: string;
  /** Every call the model made, in order — including ones that were denied. */
  calls: { call: ToolCall; approved: boolean; result: string; isError: boolean }[];
  usage: LlmUsage;
  /** True when the loop stopped on `maxIterations` rather than the model finishing. */
  exhausted: boolean;
}

export interface LlmProvider {
  readonly name: 'claude' | 'offline';
  /** True when calls reach a real model; false for the deterministic analyzer. */
  readonly live: boolean;
  complete(request: LlmRequest): Promise<LlmResult<string>>;
  /**
   * Runs an agentic tool-use loop until the model stops calling tools.
   *
   * This is the mechanism behind autonomous implementation: the engine hands
   * the model a toolset scoped to one approved item, and the model decides how
   * to carry it out. The offline provider returns an empty run so the caller
   * falls back to the deterministic handler.
   */
  runAgent(request: AgentRequest): Promise<AgentResult>;
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

  /**
   * Tool-use loop, written out rather than delegated to the SDK's tool runner.
   *
   * The runner would work, but the approval gate is the whole security story of
   * this product — an item may only ever do what its risk tier and the user's
   * trust dial allow. Keeping the loop explicit means the line where a tool is
   * blocked is visible in this file, not a callback in a beta helper.
   */
  async runAgent(request: AgentRequest): Promise<AgentResult> {
    const cfg = config();
    const model = cfg.anthropicModel;
    const maxIterations = request.maxIterations ?? 12;

    const toolsByName = new Map(request.tools.map((tool) => [tool.name, tool]));
    const toolParams: Anthropic.Tool[] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool['input_schema'],
    }));

    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: request.prompt }];
    const calls: AgentResult['calls'] = [];
    const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, usd: 0 };
    let text = '';
    let exhausted = true;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const response = await this.client.messages.create({
        model,
        max_tokens: request.maxTokens ?? 8192,
        system: request.system,
        // Adaptive thinking is off unless asked for on this model family, and
        // deciding how to carry out an instruction is exactly the kind of work
        // that benefits from it.
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        tools: toolParams,
        messages,
      });

      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      usage.usd += priceFor(model, response.usage.input_tokens, response.usage.output_tokens);

      const said = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (said) text = said;

      if (response.stop_reason !== 'tool_use') {
        exhausted = false;
        break;
      }

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      if (toolUses.length === 0) {
        exhausted = false;
        break;
      }

      // The assistant turn must go back verbatim — dropping the tool_use blocks
      // breaks the pairing the API expects on the next request.
      messages.push({ role: 'assistant', content: response.content });

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const call: ToolCall = {
          id: use.id,
          name: use.name,
          input: (use.input ?? {}) as Record<string, unknown>,
        };

        const decision = request.approve ? await request.approve(call) : { allow: true };
        if (!decision.allow) {
          const denial = decision.reason ?? 'That action was not approved.';
          calls.push({ call, approved: false, result: denial, isError: true });
          request.onToolResult?.(call, { content: denial, isError: true }, false);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: denial, is_error: true });
          continue;
        }

        const tool = toolsByName.get(use.name);
        if (!tool) {
          const missing = `No such tool: ${use.name}`;
          calls.push({ call, approved: true, result: missing, isError: true });
          results.push({ type: 'tool_result', tool_use_id: use.id, content: missing, is_error: true });
          continue;
        }

        try {
          const outcome = await tool.run(call.input);
          calls.push({ call, approved: true, result: outcome.content, isError: outcome.isError === true });
          request.onToolResult?.(call, outcome, true);
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: outcome.content,
            is_error: outcome.isError === true,
          });
        } catch (err) {
          // A throwing tool is reported back rather than aborting the run, so
          // the model can try a different approach for this one item.
          const message = errorMessage(err);
          calls.push({ call, approved: true, result: message, isError: true });
          request.onToolResult?.(call, { content: message, isError: true }, true);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: message, is_error: true });
        }
      }

      // All results for one assistant turn go back in a single user message —
      // splitting them trains the model out of making parallel calls.
      messages.push({ role: 'user', content: results });
    }

    return { text, calls, usage, exhausted };
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

  /** No model, so no agent. Callers fall back to the deterministic handler. */
  async runAgent(): Promise<AgentResult> {
    return {
      text: '',
      calls: [],
      usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
      exhausted: false,
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
