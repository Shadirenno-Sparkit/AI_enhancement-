import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { reloadConfig } from '../config.js';
import { closeDatabase, openDatabase, setDatabase } from '../db/index.js';
import { resetRateLimits } from '../api/middleware.js';
import { resetAsr, setAsrForTesting, type AsrProvider } from '../providers/asr.js';
import { resetLlm, setLlmForTesting, type LlmProvider } from '../providers/llm.js';
import { resetVision, setVisionForTesting, type VisionProvider } from '../providers/vision.js';
import { clearBinaryCache } from '../ingestion/fetcher.js';

/**
 * Per-test application instance.
 *
 * Each test gets its own temp directory, database and Express app so the suite
 * can exercise real HTTP behaviour — auth, isolation, rate limits — rather than
 * calling handlers directly. Nothing is mocked that the product depends on;
 * only the outbound providers are stubbed.
 */
export interface Harness {
  app: Express;
  dir: string;
  request: <T = unknown>(
    method: string,
    path: string,
    options?: { body?: unknown; token?: string; raw?: boolean },
  ) => Promise<{ status: number; body: T; headers: Headers }>;
  signup: (email?: string, password?: string) => Promise<{ token: string; userId: string; refreshToken: string }>;
  close: () => Promise<void>;
}

let portCursor = 41_000;

export async function createHarness(env: Record<string, string> = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiapp-test-'));

  const previousEnv = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-value-not-for-production-use',
    DATABASE_PATH: path.join(dir, 'test.sqlite'),
    STORAGE_PATH: path.join(dir, 'storage'),
    ARTIFACT_ROOT: path.join(dir, 'artifacts'),
    ANTHROPIC_API_KEY: '',
    ASR_PROVIDER: 'stub',
    VISION_PROVIDER: 'stub',
    NOTIFY_CHANNELS: 'log',
    ENABLE_BROWSER_AGENT: 'false',
    // Off by default so a stray quiet-hours window cannot make a notification
    // test flaky depending on when it runs.
    QUIET_HOURS_START: '0',
    QUIET_HOURS_END: '0',
    ...env,
  });

  reloadConfig();
  resetLlm();
  resetAsr();
  resetVision();
  resetRateLimits();
  clearBinaryCache();

  setDatabase(openDatabase(path.join(dir, 'test.sqlite')));

  const app = createApp();
  const port = portCursor++;
  const server = app.listen(port);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));

  const base = `http://127.0.0.1:${port}`;

  const request: Harness['request'] = async (method, requestPath, options = {}) => {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.token) headers['Authorization'] = `Bearer ${options.token}`;

    const response = await fetch(`${base}${requestPath}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, body: body as never, headers: response.headers };
  };

  const signup: Harness['signup'] = async (
    email = `user-${Math.random().toString(36).slice(2, 9)}@example.com`,
    password = 'correct-horse-battery-staple',
  ) => {
    const result = await request<{
      accessToken: string;
      refreshToken: string;
      user: { userId: string };
    }>('POST', '/v1/auth/signup', { body: { email, password } });
    if (result.status !== 201) throw new Error(`signup failed: ${JSON.stringify(result.body)}`);
    return {
      token: result.body.accessToken,
      refreshToken: result.body.refreshToken,
      userId: result.body.user.userId,
    };
  };

  return {
    app,
    dir,
    request,
    signup,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeDatabase();
      process.env = previousEnv;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ─── Provider stubs ──────────────────────────────────────────────────────────

/** An LLM provider that returns a fixed response, for analyzer tests. */
export function stubLlm(response: string): LlmProvider {
  const provider: LlmProvider = {
    name: 'claude',
    live: true,
    async complete() {
      return {
        value: response,
        provider: 'claude' as const,
        usage: { inputTokens: 100, outputTokens: 200, usd: 0.001 },
      };
    },
    async runAgent() {
      return { text: response, calls: [], usage: { inputTokens: 0, outputTokens: 0, usd: 0 }, exhausted: false };
    },
  };
  setLlmForTesting(provider);
  return provider;
}

/**
 * A provider that "decides" to make a scripted sequence of tool calls.
 *
 * This exists so the agentic engine can be tested without a model key: it walks
 * the plan through the same approve → run → record path the real loop uses, so
 * the approval gate and scope containment are genuinely exercised rather than
 * mocked away.
 */
export function stubAgentLlm(
  plan: { name: string; input?: Record<string, unknown> }[],
  closing = 'Done.',
): LlmProvider {
  const provider: LlmProvider = {
    name: 'claude',
    live: true,
    async complete() {
      return {
        value: '',
        provider: 'claude' as const,
        usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
      };
    },
    async runAgent(request) {
      const byName = new Map(request.tools.map((tool) => [tool.name, tool]));
      const calls: Awaited<ReturnType<LlmProvider['runAgent']>>['calls'] = [];

      for (const [index, step] of plan.entries()) {
        const call = { id: `toolu_stub_${index}`, name: step.name, input: step.input ?? {} };

        const decision = request.approve ? await request.approve(call) : { allow: true };
        if (!decision.allow) {
          const denial = decision.reason ?? 'That action was not approved.';
          calls.push({ call, approved: false, result: denial, isError: true });
          request.onToolResult?.(call, { content: denial, isError: true }, false);
          continue;
        }

        const tool = byName.get(step.name);
        if (!tool) {
          const missing = `No such tool: ${step.name}`;
          calls.push({ call, approved: true, result: missing, isError: true });
          continue;
        }

        try {
          const outcome = await tool.run(call.input);
          calls.push({ call, approved: true, result: outcome.content, isError: outcome.isError === true });
          request.onToolResult?.(call, outcome, true);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          calls.push({ call, approved: true, result: message, isError: true });
          request.onToolResult?.(call, { content: message, isError: true }, true);
        }
      }

      return {
        text: closing,
        calls,
        usage: { inputTokens: 500, outputTokens: 300, usd: 0.005 },
        exhausted: false,
      };
    },
  };
  setLlmForTesting(provider);
  return provider;
}

export function stubAsr(text: string, durationSec = 30): AsrProvider {
  const provider: AsrProvider = {
    name: 'openai',
    live: true,
    async transcribe() {
      return {
        text,
        segments: [{ startSec: 0, endSec: durationSec, text }],
        language: 'en',
        durationSec,
        confidence: 0.9,
        provider: 'openai',
      };
    },
  };
  setAsrForTesting(provider);
  return provider;
}

export function stubVision(frames: { index: number; text: string }[]): VisionProvider {
  const provider: VisionProvider = {
    name: 'claude',
    live: true,
    async read() {
      return {
        results: frames.map((frame) => ({ ...frame, confidence: 0.95, provider: 'claude' })),
        usd: 0.002,
      };
    },
  };
  setVisionForTesting(provider);
  return provider;
}

export function clearProviderStubs(): void {
  setLlmForTesting(null);
  setAsrForTesting(null);
  setVisionForTesting(null);
  resetLlm();
  resetAsr();
  resetVision();
}
