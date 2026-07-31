import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reloadConfig } from '../config.js';
import { llm, resetLlm, type LlmTool } from '../providers/llm.js';

/**
 * OpenAI provider wire format.
 *
 * The two shapes that differ from Anthropic are the ones worth pinning down:
 * tool arguments arrive as a JSON *string* rather than an object, and each tool
 * result is its own `role: "tool"` message keyed by `tool_call_id` instead of
 * sharing one user turn. Both are easy to get subtly wrong, and neither can be
 * checked without either a key or a fake server — so this stands in a fake.
 */

const previousEnv = { ...process.env };
let requests: { body: Record<string, unknown> }[] = [];

/** Queues OpenAI-shaped responses, returned one per call in order. */
function fakeOpenAi(responses: unknown[], status = 200): void {
  let index = 0;
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    requests.push({ body: JSON.parse(init.body) as Record<string, unknown> });
    const payload = responses[Math.min(index, responses.length - 1)];
    index++;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  });
}

function toolCallResponse(name: string, args: string) {
  return {
    choices: [
      {
        message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: args } }] },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
}

function finalResponse(text: string) {
  return {
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 30 },
  };
}

function testTool(onRun: (input: Record<string, unknown>) => void): LlmTool {
  return {
    name: 'write_skill',
    description: 'Write a skill.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    async run(input) {
      onRun(input);
      return { content: 'wrote it' };
    },
  };
}

beforeEach(() => {
  requests = [];
  Object.assign(process.env, {
    LLM_PROVIDER: 'openai',
    OPENAI_API_KEY: 'sk-test-not-a-real-key',
    OPENAI_MODEL: 'test-model',
    ANTHROPIC_API_KEY: '',
  });
  reloadConfig();
  resetLlm();
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...previousEnv };
  reloadConfig();
  resetLlm();
});

describe('OpenAI provider', () => {
  it('is selected when LLM_PROVIDER=openai', () => {
    expect(llm().name).toBe('openai');
    expect(llm().live).toBe(true);
  });

  it('runs a tool call and stops when the model finishes', async () => {
    fakeOpenAi([toolCallResponse('write_skill', '{"name":"weekly-review"}'), finalResponse('Created it.')]);

    let received: Record<string, unknown> | null = null;
    const result = await llm().runAgent({
      system: 'sys',
      prompt: 'do the thing',
      tools: [testTool((input) => (received = input))],
    });

    // Arguments arrive as a JSON string and must be parsed into the tool input.
    expect(received).toEqual({ name: 'weekly-review' });
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]!.approved).toBe(true);
    expect(result.text).toBe('Created it.');
    expect(result.exhausted).toBe(false);
    // Usage accumulates across both turns, not just the last.
    expect(result.usage.inputTokens).toBe(220);
  });

  it('sends each tool result back as its own role:tool message', async () => {
    fakeOpenAi([toolCallResponse('write_skill', '{"name":"x"}'), finalResponse('done')]);
    await llm().runAgent({ system: 's', prompt: 'p', tools: [testTool(() => {})] });

    // The second request must carry the assistant turn verbatim plus a tool
    // message whose tool_call_id matches — otherwise OpenAI 400s.
    const second = requests[1]!.body as { messages: { role: string; tool_call_id?: string }[] };
    const toolMessage = second.messages.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.tool_call_id).toBe('call_1');
    expect(second.messages.some((m) => m.role === 'assistant')).toBe(true);
  });

  it('never runs a tool the approval gate denied', async () => {
    fakeOpenAi([toolCallResponse('write_skill', '{"name":"x"}'), finalResponse('understood')]);

    let ran = false;
    const result = await llm().runAgent({
      system: 's',
      prompt: 'p',
      tools: [testTool(() => (ran = true))],
      approve: async () => ({ allow: false, reason: 'Not permitted.' }),
    });

    expect(ran).toBe(false);
    expect(result.calls[0]!.approved).toBe(false);
    expect(result.calls[0]!.result).toBe('Not permitted.');
  });

  it('treats malformed tool arguments as a recoverable error, not a crash', async () => {
    fakeOpenAi([toolCallResponse('write_skill', '{not valid json'), finalResponse('retrying')]);

    let ran = false;
    const result = await llm().runAgent({
      system: 's',
      prompt: 'p',
      tools: [testTool(() => (ran = true))],
    });

    expect(ran).toBe(false);
    expect(result.calls[0]!.isError).toBe(true);
    expect(result.calls[0]!.result).toMatch(/valid JSON/i);
  });

  it('explains a 404 by naming OPENAI_MODEL rather than failing silently', async () => {
    fakeOpenAi([{ error: { message: 'The model `test-model` does not exist' } }], 404);

    await expect(
      llm().runAgent({ system: 's', prompt: 'p', tools: [testTool(() => {})] }),
    ).rejects.toThrow(/OPENAI_MODEL/);
  });
});
