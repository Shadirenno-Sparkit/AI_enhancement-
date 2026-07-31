import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { createLogger, errorMessage } from '../util/logger.js';

const log = createLogger('llm');

export type LlmProviderName = 'claude' | 'openai' | 'offline';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface LlmResult<T> {
  value: T;
  usage: LlmUsage;
  /** Which provider actually served the call — surfaced for source transparency. */
  provider: LlmProviderName;
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
  readonly name: LlmProviderName;
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

// ─── OpenAI ──────────────────────────────────────────────────────────────────

/** The subset of the Chat Completions wire format this provider relies on. */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | { type: string; text?: string; image_url?: { url: string } }[] | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ChatResponse {
  choices?: {
    message?: ChatMessage;
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string; type?: string };
}

/**
 * OpenAI (and OpenAI-compatible) provider.
 *
 * Written against the HTTP API with `fetch` rather than the SDK, matching how
 * `providers/asr.ts` already talks to Whisper — one less dependency, and it
 * works unchanged against Azure OpenAI or any compatible gateway via
 * OPENAI_BASE_URL.
 *
 * Two shape differences from Anthropic matter and are handled below:
 *   - tool arguments arrive as a JSON *string* that has to be parsed, and can
 *     be malformed;
 *   - each tool result is its own `role: "tool"` message keyed by
 *     `tool_call_id`, rather than all results sharing one user turn.
 */
class GptProvider implements LlmProvider {
  readonly name = 'openai' as const;
  readonly live = true;

  constructor(private apiKey: string) {}

  private price(inputTokens: number, outputTokens: number): number {
    const cfg = config();
    return (
      (inputTokens / 1_000_000) * cfg.openaiInputUsdPerMTok +
      (outputTokens / 1_000_000) * cfg.openaiOutputUsdPerMTok
    );
  }

  /**
   * One Chat Completions call.
   *
   * Newer models require `max_completion_tokens` while older ones only accept
   * `max_tokens`, and which is which keeps moving. Rather than pin a guess,
   * this sends the modern field and retries once on the specific 400 that says
   * otherwise.
   */
  private async post(body: Record<string, unknown>, maxTokens: number): Promise<ChatResponse> {
    const cfg = config();
    const send = async (tokenField: 'max_completion_tokens' | 'max_tokens'): Promise<Response> =>
      fetch(`${cfg.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, [tokenField]: maxTokens }),
        signal: AbortSignal.timeout(120_000),
      });

    let response = await send('max_completion_tokens');
    if (response.status === 400) {
      const text = await response.text();
      if (/max_completion_tokens|max_tokens/i.test(text)) {
        response = await send('max_tokens');
      } else {
        throw new Error(describeOpenAiError(response.status, text));
      }
    }

    if (!response.ok) {
      // Loud and specific. A silently-swallowed 404 on a wrong model ID is
      // exactly how this app previously appeared "live" while every call fell
      // back to the offline analyzer.
      throw new Error(describeOpenAiError(response.status, await response.text()));
    }
    return (await response.json()) as ChatResponse;
  }

  async complete(request: LlmRequest): Promise<LlmResult<string>> {
    const cfg = config();
    const model = request.fast ? cfg.openaiFastModel : cfg.openaiModel;

    // Vision: images ride along as data URLs in the user turn.
    const content: NonNullable<ChatMessage['content']> = [];
    for (const image of request.images ?? []) {
      content.push({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } });
    }
    content.push({ type: 'text', text: request.prompt });

    const data = await this.post(
      {
        model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content },
        ],
      },
      request.maxTokens ?? 4096,
    );

    const message = data.choices?.[0]?.message;
    const text = typeof message?.content === 'string' ? message.content : '';
    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;

    return {
      value: text,
      provider: 'openai',
      usage: { inputTokens, outputTokens, usd: this.price(inputTokens, outputTokens) },
    };
  }

  /** Same contract as the Claude loop: nothing runs until `approve` says yes. */
  async runAgent(request: AgentRequest): Promise<AgentResult> {
    const cfg = config();
    const model = cfg.openaiModel;
    const maxIterations = request.maxIterations ?? 12;

    const toolsByName = new Map(request.tools.map((tool) => [tool.name, tool]));
    const toolParams = request.tools.map((tool) => ({
      type: 'function' as const,
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    }));

    const messages: ChatMessage[] = [
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt },
    ];
    const calls: AgentResult['calls'] = [];
    const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, usd: 0 };
    let text = '';
    let exhausted = true;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const data = await this.post({ model, messages, tools: toolParams }, request.maxTokens ?? 8192);

      const inputTokens = data.usage?.prompt_tokens ?? 0;
      const outputTokens = data.usage?.completion_tokens ?? 0;
      usage.inputTokens += inputTokens;
      usage.outputTokens += outputTokens;
      usage.usd += this.price(inputTokens, outputTokens);

      const message = data.choices?.[0]?.message;
      if (!message) {
        exhausted = false;
        break;
      }
      if (typeof message.content === 'string' && message.content.trim()) text = message.content.trim();

      const toolCalls = message.tool_calls ?? [];
      if (toolCalls.length === 0) {
        exhausted = false;
        break;
      }

      // The assistant turn must go back verbatim so each tool_call_id resolves.
      messages.push(message);

      for (const toolCall of toolCalls) {
        // Arguments are a JSON string, and a model can emit a malformed one.
        // Treat that as a tool error the model can recover from, not a crash.
        let input: Record<string, unknown> = {};
        let parseError: string | null = null;
        try {
          input = toolCall.function.arguments ? (JSON.parse(toolCall.function.arguments) as Record<string, unknown>) : {};
        } catch {
          parseError = `Arguments for ${toolCall.function.name} were not valid JSON. Send them again as a JSON object.`;
        }

        const call: ToolCall = { id: toolCall.id, name: toolCall.function.name, input };

        if (parseError) {
          calls.push({ call, approved: false, result: parseError, isError: true });
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: parseError });
          continue;
        }

        const decision = request.approve ? await request.approve(call) : { allow: true };
        if (!decision.allow) {
          const denial = decision.reason ?? 'That action was not approved.';
          calls.push({ call, approved: false, result: denial, isError: true });
          request.onToolResult?.(call, { content: denial, isError: true }, false);
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: denial });
          continue;
        }

        const tool = toolsByName.get(call.name);
        if (!tool) {
          const missing = `No such tool: ${call.name}`;
          calls.push({ call, approved: true, result: missing, isError: true });
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: missing });
          continue;
        }

        try {
          const outcome = await tool.run(call.input);
          calls.push({ call, approved: true, result: outcome.content, isError: outcome.isError === true });
          request.onToolResult?.(call, outcome, true);
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: outcome.content });
        } catch (err) {
          const message = errorMessage(err);
          calls.push({ call, approved: true, result: message, isError: true });
          request.onToolResult?.(call, { content: message, isError: true }, true);
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: message });
        }
      }
    }

    return { text, calls, usage, exhausted };
  }
}

/** Turns an OpenAI error body into something worth putting in a log line. */
function describeOpenAiError(status: number, body: string): string {
  let detail = body.slice(0, 400);
  try {
    const parsed = JSON.parse(body) as ChatResponse;
    if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    // Non-JSON body; the raw text is the best we have.
  }
  if (status === 401) return `OpenAI rejected the API key (401). ${detail}`;
  if (status === 404) {
    return (
      `OpenAI returned 404 for model "${config().openaiModel}". Set OPENAI_MODEL in .env to a model ` +
      `your account can access. ${detail}`
    );
  }
  if (status === 429) return `OpenAI rate limit or quota exceeded (429). ${detail}`;
  return `OpenAI request failed (${status}). ${detail}`;
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

/**
 * Picks the provider from LLM_PROVIDER, defaulting to whichever key is present.
 *
 * When both keys are set, Anthropic wins — pin LLM_PROVIDER=openai to override.
 */
export function llm(): LlmProvider {
  if (cached) return cached;
  const cfg = config();
  const choice = cfg.llmProvider.trim().toLowerCase();

  const useClaude = choice === 'claude' || (choice === 'auto' && Boolean(cfg.anthropicApiKey));
  const useOpenAi = choice === 'openai' || (choice === 'auto' && !cfg.anthropicApiKey && Boolean(cfg.openaiApiKey));

  if (useClaude && cfg.anthropicApiKey) {
    log.info('using Claude for analysis and implementation', { model: cfg.anthropicModel });
    cached = new ClaudeProvider(cfg.anthropicApiKey);
  } else if (useOpenAi && cfg.openaiApiKey) {
    log.info('using OpenAI for analysis and implementation', {
      model: cfg.openaiModel,
      baseUrl: cfg.openaiBaseUrl,
    });
    cached = new GptProvider(cfg.openaiApiKey);
  } else {
    if (choice === 'claude') log.error('LLM_PROVIDER=claude but ANTHROPIC_API_KEY is empty');
    else if (choice === 'openai') log.error('LLM_PROVIDER=openai but OPENAI_API_KEY is empty');
    else log.warn('no model key set (ANTHROPIC_API_KEY / OPENAI_API_KEY) — using the offline analyzer');
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
