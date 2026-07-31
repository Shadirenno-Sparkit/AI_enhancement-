import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ITEM_TYPE_SCOPES, type ItemType } from '@aiapp/shared';
import { createHarness, clearProviderStubs, stubAgentLlm, type Harness } from './harness.js';
import { drain } from '../queue/queue.js';
import { handleQueueItem } from '../queue/worker.js';
import { getSpecByJob } from '../repo/specs.js';
import { listAudit } from '../repo/audit.js';
import { AGENTIC_TOOLSETS } from '../implementation/tools.js';

/**
 * Agentic implementation (spec §4.6).
 *
 * These cover the property that matters most about letting a model drive: it
 * can only ever reach the permissions the *item type* carries, no matter what
 * it asks for. The stub provider walks a scripted plan through the same
 * approve → run → record path the real loop uses, so the gate is genuinely
 * exercised without needing a model key.
 */

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  clearProviderStubs();
  await harness.close();
});

async function runQueue(): Promise<void> {
  await drain(handleQueueItem, 50);
}

/** Captures a link, processes it, and returns the create_skill item if one was proposed. */
async function captureSkillItem(token: string, url: string, sharedText: string) {
  const capture = await harness.request<{ jobId: string }>('POST', '/v1/links', {
    token,
    body: { url, sharedText },
  });
  await runQueue();
  const spec = getSpecByJob(capture.body.jobId)!;
  return { spec, item: spec.items.find((entry) => entry.type === 'create_skill') };
}

describe('agentic implementation', () => {
  it('lets the model inspect and then write a real skill', async () => {
    // The model looks first, then writes — the ordering this toolset exists for.
    stubAgentLlm(
      [
        { name: 'list_skills' },
        {
          name: 'write_skill',
          input: {
            name: 'weekly-review',
            description: 'Draft a weekly review from the week’s notes.',
            body: '# Weekly review\n\n## What this does\n\nDrafts a weekly review.\n\n1. Gather notes\n2. Summarise',
          },
        },
      ],
      'Created the weekly-review skill.',
    );

    const { token, userId } = await harness.signup('agentic@example.com');
    const { spec, item } = await captureSkillItem(
      token,
      'https://www.instagram.com/reel/AGENTIC1/',
      'Create a reusable skill that drafts your weekly review.',
    );
    expect(item).toBeDefined();

    const decision = await harness.request<{ runId: string }>('POST', `/v1/specs/${spec.specId}/decisions`, {
      token,
      body: { items: [{ itemId: item!.itemId, decision: 'approve' }] },
    });
    await runQueue();

    // The skill landed where it is actually usable, under the name the model chose.
    const skillFile = path.join(harness.dir, 'artifacts', userId, '_skills', 'weekly-review.md');
    expect(fs.existsSync(skillFile)).toBe(true);
    expect(fs.readFileSync(skillFile, 'utf8')).toContain('## What this does');

    const run = await harness.request<{ run: { items: { status: string; summary: string }[] } }>(
      'GET',
      `/v1/runs/${decision.body.runId}`,
      { token },
    );
    expect(run.body.run.items[0]!.status).toBe('done');
    expect(run.body.run.items[0]!.summary).toContain('weekly-review');
  });

  it('keeps an agentic run reversible', async () => {
    stubAgentLlm([
      {
        name: 'write_skill',
        input: { name: 'release-notes', description: 'Draft release notes.', body: '# Release notes\n\nSteps here.' },
      },
    ]);

    const { token, userId } = await harness.signup('agentic-undo@example.com');
    const { spec, item } = await captureSkillItem(
      token,
      'https://www.youtube.com/watch?v=AGENTIC2',
      'Create a reusable skill that drafts your release notes.',
    );
    expect(item).toBeDefined();

    await harness.request('POST', `/v1/specs/${spec.specId}/decisions`, {
      token,
      body: { items: [{ itemId: item!.itemId, decision: 'approve' }] },
    });
    await runQueue();

    const skillsDir = path.join(harness.dir, 'artifacts', userId, '_skills');
    const before = fs.readdirSync(skillsDir).length;
    expect(before).toBeGreaterThan(0);

    const revert = await harness.request('POST', `/v1/specs/${spec.specId}/revert/${item!.itemId}`, { token });
    expect(revert.status).toBe(200);
    expect(fs.readdirSync(skillsDir).length).toBe(before - 1);
  });

  it('denies a tool the item was never granted, and says why', async () => {
    // A model that invents a capability gets refused rather than obeyed.
    stubAgentLlm([
      { name: 'run_shell_command', input: { command: 'rm -rf /' } },
      {
        name: 'write_skill',
        input: { name: 'safe-skill', description: 'A legitimate skill.', body: '# Safe\n\nContent.' },
      },
    ]);

    const { token, userId } = await harness.signup('agentic-deny@example.com');
    const { spec, item } = await captureSkillItem(
      token,
      'https://www.instagram.com/reel/AGENTIC3/',
      'Create a reusable skill that drafts your standup notes.',
    );
    expect(item).toBeDefined();

    const decision = await harness.request<{ runId: string }>('POST', `/v1/specs/${spec.specId}/decisions`, {
      token,
      body: { items: [{ itemId: item!.itemId, decision: 'approve' }] },
    });
    await runQueue();

    // The invented tool did nothing; the legitimate one still ran.
    const run = await harness.request<{ run: { items: { status: string; actions: string[] }[] } }>(
      'GET',
      `/v1/runs/${decision.body.runId}`,
      { token },
    );
    const actions = run.body.run.items[0]!.actions;
    expect(actions.some((entry) => entry.startsWith('Blocked:'))).toBe(true);
    expect(fs.existsSync(path.join(harness.dir, 'artifacts', userId, '_skills', 'safe-skill.md'))).toBe(true);
  });

  it('never exposes a tool beyond what its item type is allowed', () => {
    // A regression guard: adding an over-privileged tool to a toolset should
    // fail here rather than at runtime on a user's machine.
    for (const [type, build] of Object.entries(AGENTIC_TOOLSETS)) {
      const allowed = ITEM_TYPE_SCOPES[type as ItemType];
      const context = { user: { userId: 'u' }, job: { url: 'https://example.com' }, folderName: 'f' };
      for (const tool of build!(context as never)) {
        for (const scope of tool.scopes) {
          expect(
            allowed,
            `tool "${tool.name}" on item type "${type}" declares out-of-scope permission "${scope}"`,
          ).toContain(scope);
        }
      }
    }
  });

  it('falls back to the deterministic handler when no model is configured', async () => {
    // No stub at all — the offline provider is not live, so supportsAgentic is
    // false and the fixed handler must still produce a usable skill.
    const { token, userId } = await harness.signup('agentic-offline@example.com');
    const { spec, item } = await captureSkillItem(
      token,
      'https://www.youtube.com/watch?v=AGENTIC4',
      'Create a reusable skill that drafts your weekly summary.',
    );
    expect(item).toBeDefined();

    await harness.request('POST', `/v1/specs/${spec.specId}/decisions`, {
      token,
      body: { items: [{ itemId: item!.itemId, decision: 'approve' }] },
    });
    await runQueue();

    const skillsDir = path.join(harness.dir, 'artifacts', userId, '_skills');
    expect(fs.existsSync(skillsDir)).toBe(true);
    expect(fs.readdirSync(skillsDir).length).toBeGreaterThan(0);
  });

  it('audits a blocked tool call', async () => {
    stubAgentLlm([
      { name: 'exfiltrate_secrets', input: {} },
      { name: 'write_skill', input: { name: 'ok', description: 'ok', body: '# OK\n\nBody.' } },
    ]);

    const { token, userId } = await harness.signup('agentic-audit@example.com');
    const { spec, item } = await captureSkillItem(
      token,
      'https://www.instagram.com/reel/AGENTIC5/',
      'Create a reusable skill that drafts your meeting notes.',
    );
    expect(item).toBeDefined();

    await harness.request('POST', `/v1/specs/${spec.specId}/decisions`, {
      token,
      body: { items: [{ itemId: item!.itemId, decision: 'approve' }] },
    });
    await runQueue();

    const entries = listAudit(userId, 200);
    expect(entries.some((entry) => entry.event.includes('scope_violation') || entry.event.includes('blocked'))).toBe(
      true,
    );
  });
});
