import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIFE_DOMAINS, ITEM_TYPE_SCOPES, ITEM_TYPES } from '@aiapp/shared';
import { createHarness, clearProviderStubs, type Harness } from './harness.js';
import { buildLifeContext, listFacts, profileCompleteness, proposeFacts, upsertFact } from '../repo/profile.js';
import { triageOffline, shouldAutoPlan } from '../analysis/triage.js';
import { buildN8nWorkflow } from '../implementation/automation.js';

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  clearProviderStubs();
  await harness.close();
});

describe('life context graph', () => {
  it('keeps one value per key so the analyzer never sees contradictions', async () => {
    const { userId } = await harness.signup();

    upsertFact({ userId, category: 'device', key: 'phone', value: 'iPhone 13' });
    upsertFact({ userId, category: 'device', key: 'phone', value: 'iPhone 15 Pro' });

    const facts = listFacts(userId).filter((fact) => fact.key === 'phone');
    expect(facts).toHaveLength(1);
    expect(facts[0]!.value).toBe('iPhone 15 Pro');
  });

  it('treats key spellings as the same fact', async () => {
    const { userId } = await harness.signup();

    upsertFact({ userId, category: 'preference', key: 'Reading Format', value: 'audiobooks' });
    upsertFact({ userId, category: 'preference', key: 'reading_format', value: 'print' });

    expect(listFacts(userId).filter((f) => f.key === 'reading_format')).toHaveLength(1);
  });

  it('never lets an inferred guess overwrite something the user stated', async () => {
    const { userId } = await harness.signup();
    upsertFact({ userId, category: 'device', key: 'phone', value: 'iPhone 15 Pro', source: 'user_stated' });

    proposeFacts(userId, 'job_x', [
      {
        category: 'device',
        key: 'phone',
        value: 'Android',
        confidence: 0.9,
        evidence: 'mentioned an Android app',
      },
    ]);

    const phone = listFacts(userId).find((fact) => fact.key === 'phone')!;
    expect(phone.value).toBe('iPhone 15 Pro');
    expect(phone.confirmed).toBe(true);
  });

  it('keeps inferred facts out of the analyzer until they are confirmed', async () => {
    const { userId } = await harness.signup();

    proposeFacts(userId, 'job_x', [
      {
        category: 'tool',
        key: 'notes_app',
        value: 'Obsidian',
        confidence: 0.8,
        evidence: 'said "my Obsidian vault"',
      },
    ]);

    // Present in the graph, absent from the brief the analyzer reads.
    const stored = listFacts(userId).find((fact) => fact.key === 'notes_app');
    expect(stored?.confirmed).toBe(false);

    const context = buildLifeContext(userId);
    expect(context.brief).not.toContain('Obsidian');
    expect(context.pendingCount).toBe(1);

    const { token } = await harness.signup('confirmer@example.com');
    void token;
  });

  it('includes a fact in the brief once confirmed', async () => {
    const { token, userId } = await harness.signup();

    proposeFacts(userId, 'job_x', [
      { category: 'tool', key: 'notes_app', value: 'Obsidian', confidence: 0.8, evidence: 'said so' },
    ]);
    const pending = listFacts(userId).find((fact) => fact.key === 'notes_app')!;

    const response = await harness.request('POST', `/v1/profile/facts/${pending.factId}/confirm`, { token });
    expect(response.status).toBe(200);

    expect(buildLifeContext(userId).brief).toContain('Obsidian');
  });

  it('caps the brief so a rich profile does not become an expensive one', async () => {
    const { userId } = await harness.signup();
    for (let index = 0; index < 200; index++) {
      upsertFact({
        userId,
        category: 'preference',
        key: `preference_${index}`,
        value: 'x'.repeat(120),
      });
    }

    const context = buildLifeContext(userId, { maxChars: 1000 });
    expect(context.brief.length).toBeLessThanOrEqual(1000);
    // The cap truncates what is sent, not what is stored.
    expect(context.factCount).toBe(200);
  });

  it('reports completeness and names the gaps', async () => {
    const { userId } = await harness.signup();
    const empty = profileCompleteness(userId);

    upsertFact({ userId, category: 'preference', key: 'reading_format', value: 'audiobooks' });
    const after = profileCompleteness(userId);

    expect(after.completeness).toBeGreaterThan(empty.completeness);
    expect(after.gaps).not.toContain('preference');
    expect(after.gaps).toContain('goal');
  });

  it('erases the profile on a data-deletion request', async () => {
    const { token, userId } = await harness.signup();
    upsertFact({ userId, category: 'identity', key: 'city', value: 'Toronto' });
    expect(listFacts(userId).length).toBeGreaterThan(0);

    const response = await harness.request('DELETE', '/v1/users/me/data', {
      token,
      body: { keepAccount: true },
    });
    expect([200, 204]).toContain(response.status);
    expect(listFacts(userId)).toHaveLength(0);
  });
});

describe('profile API', () => {
  it('round-trips a stated fact and rejects an unknown category', async () => {
    const { token } = await harness.signup();

    const created = await harness.request<{ fact: { key: string } }>('POST', '/v1/profile/facts', {
      token,
      body: { category: 'preference', key: 'reading_format', value: 'audiobooks on the commute' },
    });
    expect(created.status).toBe(201);

    const profile = await harness.request<{ facts: { key: string }[]; completeness: number }>(
      'GET',
      '/v1/profile',
      { token },
    );
    expect(profile.body.facts.map((fact) => fact.key)).toContain('reading_format');

    const bad = await harness.request('POST', '/v1/profile/facts', {
      token,
      body: { category: 'not_a_category', key: 'x', value: 'y' },
    });
    expect(bad.status).toBe(400);
  });

  it('keeps one user’s profile invisible to another', async () => {
    const first = await harness.signup('a@example.com');
    const second = await harness.signup('b@example.com');

    await harness.request('POST', '/v1/profile/facts', {
      token: first.token,
      body: { category: 'identity', key: 'city', value: 'Toronto' },
    });

    const theirs = await harness.request<{ facts: unknown[] }>('GET', '/v1/profile', { token: second.token });
    expect(theirs.body.facts).toHaveLength(0);

    // And one cannot delete the other's facts.
    const mine = listFacts(first.userId)[0]!;
    const attempt = await harness.request('DELETE', `/v1/profile/facts/${mine.factId}`, {
      token: second.token,
    });
    expect(attempt.status).toBe(404);
    expect(listFacts(first.userId)).toHaveLength(1);
  });
});

describe('triage (phase A)', () => {
  it('scores entertainment as no_action for cost triage without treating extraction as a failure', () => {
    const result = triageOffline({
      text: 'POV: when the code compiles first try 😂 nah that never happens. Follow for more!',
      sourceLabel: 'TikTok',
    });
    expect(result.verdict).toBe('no_action');
    expect(result.valueScore).toBe(0);
    expect(result.usage.usd).toBe(0);
  });

  it('recognises practical advice and names the domain', () => {
    const result = triageOffline({
      text:
        'You should set up a reusable Claude skill that reads your inbox every morning and writes five bullets. ' +
        'Then schedule it so it runs automatically before you start work.',
      sourceLabel: 'YouTube',
    });
    expect(result.verdict).toBe('actionable');
    expect(result.domains).toContain('ai_workflow');
    expect(result.valueScore).toBeGreaterThan(0.3);
  });

  it('classifies a book recommendation as learning, not AI workflow', () => {
    const result = triageOffline({
      text: 'The audiobook of Deep Work is worth reading — the chapter on shutdown rituals changed how I finish my day.',
      sourceLabel: 'Note',
    });
    expect(result.domains).toContain('learning');
  });

  it('never lets a no_action verdict pass the generic score gate', () => {
    const result = triageOffline({ text: 'POV: me 😂 follow for more', sourceLabel: 'Reel' });
    expect(shouldAutoPlan(result, 0)).toBe(false);
  });

  it('gates on the threshold', () => {
    const high = { valueScore: 0.8, verdict: 'actionable' as const };
    const low = { valueScore: 0.2, verdict: 'actionable' as const };
    const base = { domains: [], headline: '', estimatedItems: 0, usage: { modelTokens: 0, usd: 0 }, engine: 'offline' as const };

    expect(shouldAutoPlan({ ...base, ...high }, 0.55)).toBe(true);
    expect(shouldAutoPlan({ ...base, ...low }, 0.55)).toBe(false);
    // A threshold above 1 plans nothing automatically.
    expect(shouldAutoPlan({ ...base, ...high }, 1.01)).toBe(false);
  });
});

describe('universal capture', () => {
  it('accepts a typed note with no link in it', async () => {
    const { token } = await harness.signup();

    const response = await harness.request<{ jobId: string }>('POST', '/v1/captures', {
      token,
      body: {
        kind: 'text',
        text:
          'Someone at the gym said you should read Atomic Habits — the idea about habit stacking, ' +
          'attaching a new habit to one you already do, sounds like it would work for my morning.',
      },
    });

    expect(response.status).toBe(202);
    expect(response.body.jobId).toBeTruthy();
  });

  it('folds a re-typed identical note into the original capture', async () => {
    const { token } = await harness.signup();
    const body = { kind: 'text', text: 'Cancel the subscriptions I have not opened in 90 days.' };

    const first = await harness.request<{ jobId: string }>('POST', '/v1/captures', { token, body });
    const second = await harness.request<{ jobId: string; deduped: boolean }>('POST', '/v1/captures', {
      token,
      body,
    });

    expect(second.body.deduped).toBe(true);
    expect(second.body.jobId).toBe(first.body.jobId);
  });

  it('rejects an empty capture rather than filing a job with nothing in it', async () => {
    const { token } = await harness.signup();
    const response = await harness.request('POST', '/v1/captures', { token, body: { kind: 'text', text: '   ' } });
    expect(response.status).toBe(400);
  });

  it('rejects a voice capture with no recording attached', async () => {
    const { token } = await harness.signup();
    const response = await harness.request('POST', '/v1/captures', { token, body: { kind: 'voice' } });
    expect(response.status).toBe(400);
  });

  it('processes a note end to end without ever touching the network', async () => {
    const { token } = await harness.signup();
    const capture = await harness.request<{ jobId: string }>('POST', '/v1/captures', {
      token,
      body: {
        kind: 'text',
        text:
          'Create a reusable skill that drafts my weekly update, and add a standing instruction ' +
          'to always keep summaries to five bullets.',
      },
    });

    const { drain } = await import('../queue/queue.js');
    const { handleQueueItem } = await import('../queue/worker.js');
    await drain(handleQueueItem, 50);

    const { getJobUnscoped } = await import('../repo/jobs.js');
    const { getSpecByJob } = await import('../repo/specs.js');

    const job = getJobUnscoped(capture.body.jobId)!;
    expect(job.inputKind).toBe('text');
    expect(job.state).toBe('SPEC_READY');

    const spec = getSpecByJob(capture.body.jobId)!;
    expect(spec.items.length).toBeGreaterThan(0);
    // Even offline, every item lands on a route so nothing is unreachable.
    expect(spec.pathways.length).toBeGreaterThan(0);
    const reachable = new Set(spec.pathways.flatMap((pathway) => pathway.itemIds));
    for (const item of spec.items) expect(reachable.has(item.itemId)).toBe(true);
  });
});

describe('life-domain item safety', () => {
  it('gives no item type the power to complete a purchase or send a message', () => {
    // The guarantee is structural: no such scope exists to be granted.
    const everyScope = new Set(ITEM_TYPES.flatMap((type) => ITEM_TYPE_SCOPES[type]));
    for (const scope of everyScope) {
      expect(scope).not.toMatch(/purchase|checkout|payment|send$/);
    }
    // The money-spending types can only ever prepare.
    expect(ITEM_TYPE_SCOPES['purchase']).toContain('commerce:prepare');
    expect(ITEM_TYPE_SCOPES['acquire_media']).toContain('commerce:prepare');
    expect(ITEM_TYPE_SCOPES['contact_person']).toContain('outbox:draft');
  });

  it('rates anything touching money or other people above the safe tier', async () => {
    const { ITEM_TYPE_RISK } = await import('@aiapp/shared');
    expect(ITEM_TYPE_RISK['purchase']).toBe('sensitive');
    expect(ITEM_TYPE_RISK['financial_review']).toBe('sensitive');
    expect(ITEM_TYPE_RISK['contact_person']).not.toBe('safe');
    expect(ITEM_TYPE_RISK['acquire_media']).not.toBe('safe');
  });

  it('covers every domain with a label', async () => {
    const { LIFE_DOMAIN_LABELS } = await import('@aiapp/shared');
    for (const domain of LIFE_DOMAINS) expect(LIFE_DOMAIN_LABELS[domain]).toBeTruthy();
  });
});

describe('n8n workflow export', () => {
  it('produces an importable workflow with every step chained', () => {
    const workflow = buildN8nWorkflow({
      name: 'Weekly review digest',
      cron: '0 17 * * 5',
      steps: [
        { name: 'Read the week', tool: 'gmail', action: 'search' },
        { name: 'Summarize', tool: 'claude', action: 'complete' },
        { name: 'Post it', tool: 'slack', action: 'postMessage' },
      ],
    });

    // Trigger plus one node per step.
    expect(workflow.nodes).toHaveLength(4);
    expect(workflow.nodes[0]!.type).toBe('n8n-nodes-base.scheduleTrigger');

    // Every node except the last hands off to exactly one successor.
    const names = workflow.nodes.map((node) => node.name);
    for (let index = 0; index < names.length - 1; index++) {
      const connection = workflow.connections[names[index]!];
      expect(connection?.main[0]?.[0]?.node).toBe(names[index + 1]);
    }
    expect(workflow.connections[names.at(-1)!]).toBeUndefined();

    // Node ids must be unique or n8n silently drops nodes on import.
    expect(new Set(workflow.nodes.map((node) => node.id)).size).toBe(workflow.nodes.length);
  });

  it('uses a manual trigger when there is no schedule, so an import never starts running', () => {
    const workflow = buildN8nWorkflow({ name: 'Ad hoc', steps: [{ name: 'Do the thing' }] });
    expect(workflow.nodes[0]!.type).toBe('n8n-nodes-base.manualTrigger');
  });

  it('disambiguates duplicate step names, which n8n keys its graph by', () => {
    const workflow = buildN8nWorkflow({
      name: 'Repeats',
      steps: [{ name: 'Fetch' }, { name: 'Fetch' }, { name: 'Fetch' }],
    });
    const names = workflow.nodes.map((node) => node.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('round-trips as JSON', () => {
    const workflow = buildN8nWorkflow({ name: 'Trip', steps: [{ name: 'One' }] });
    expect(() => JSON.parse(JSON.stringify(workflow))).not.toThrow();
  });
});

describe('offline extraction of spoken and life-domain advice', () => {
  it('strips the messenger from reported speech', async () => {
    const { stripAdviceFraming } = await import('../analysis/heuristics.js');

    expect(stripAdviceFraming('He said you should create a reusable skill')).toBe('create a reusable skill');
    expect(stripAdviceFraming('Someone recommended setting up a weekly review')).toBe('setting up a weekly review');
    expect(stripAdviceFraming('She swears by keeping summaries short')).toBe('keeping summaries short');
    expect(stripAdviceFraming('The guy at the gym said you should read it')).toBe('read it');
    // Nested framing unwinds fully.
    expect(stripAdviceFraming('He said you should also just turn on memory')).toBe('turn on memory');
  });

  it('never strips a sentence down to nothing', async () => {
    const { stripAdviceFraming } = await import('../analysis/heuristics.js');
    // A sentence that is entirely framing keeps its original text rather than
    // becoming an empty item.
    expect(stripAdviceFraming('You should')).toBeTruthy();
    expect(stripAdviceFraming('He said')).toBeTruthy();
  });

  it('matches imperative verbs through their inflections', async () => {
    const { verbForms } = await import('../analysis/heuristics.js');

    expect(verbForms('cancelling')).toContain('cancel');
    expect(verbForms('setting')).toContain('set');
    expect(verbForms('creating')).toContain('create');
    expect(verbForms('scheduled')).toContain('schedule');
    expect(verbForms('reads')).toContain('read');
    // A bare stem still matches itself.
    expect(verbForms('add')).toContain('add');
  });

  it('pulls every distinct tip out of an overheard recommendation', async () => {
    const { extractCandidateTips, titleFromTip } = await import('../analysis/heuristics.js');

    const text = [
      '[0] (user_note) Guy at the coffee shop said Deep Work by Cal Newport changed how he works.',
      '[0] (user_note) He said you should create a reusable skill that blocks out a focus session every morning.',
      '[0] (user_note) And set a standing instruction to keep all summaries to five bullets.',
      '[0] (user_note) Also worth cancelling any subscription you have not opened in 90 days.',
    ].join('\n');

    const tips = extractCandidateTips(text, 6);
    const types = tips.map((tip) => tip.type);

    expect(types).toContain('create_skill');
    expect(types).toContain('set_instruction');
    // Money advice is recognised as its own domain, not forced into an AI item.
    expect(types).toContain('financial_review');

    // Titles lead with the advice, not with who said it.
    for (const tip of tips) {
      const title = titleFromTip(tip.text);
      expect(title.toLowerCase()).not.toMatch(/^(he|she|they|someone|guy|the guy) /);
      expect(title.toLowerCase()).not.toMatch(/^you should /);
    }
  });

  it('types "create a skill that runs every morning" as a skill, not a schedule', async () => {
    const { extractCandidateTips } = await import('../analysis/heuristics.js');
    const tips = extractCandidateTips(
      '[0] (user_note) Create a reusable skill that blocks out a focus session every morning.',
      3,
    );
    // The recurrence is a property of the skill; the sentence is about the skill.
    expect(tips[0]?.type).toBe('create_skill');
  });

  it('recognises a book recommendation as something to acquire', async () => {
    const { extractCandidateTips } = await import('../analysis/heuristics.js');
    const tips = extractCandidateTips(
      '[0] (user_note) Get the audiobook of Deep Work — it is worth the credit.',
      3,
    );
    expect(tips.map((tip) => tip.type)).toContain('acquire_media');
  });

  it('still refuses to promote entertainment', async () => {
    const { extractCandidateTips } = await import('../analysis/heuristics.js');
    const tips = extractCandidateTips(
      '[0] (post_description) POV: when the code compiles first try 😂 nah that never happens. Follow for more!',
      6,
    );
    expect(tips).toHaveLength(0);
  });
});

describe('confirming what the trust dial held', () => {
  /** Captures a note and approves every item, returning the spec and first run. */
  async function approveAll(token: string) {
    const capture = await harness.request<{ jobId: string }>('POST', '/v1/captures', {
      token,
      body: {
        kind: 'text',
        text:
          'Create a reusable skill that drafts my weekly update. ' +
          'Also worth cancelling any subscription you have not opened in 90 days.',
      },
    });

    const { drain } = await import('../queue/queue.js');
    const { handleQueueItem } = await import('../queue/worker.js');
    await drain(handleQueueItem, 50);

    const { getSpecByJob } = await import('../repo/specs.js');
    const spec = getSpecByJob(capture.body.jobId)!;

    const decision = await harness.request<{ runId: string; awaitingConfirmation: string[] }>(
      'POST',
      `/v1/specs/${spec.specId}/decisions`,
      { token, body: { items: spec.items.map((item) => ({ itemId: item.itemId, decision: 'approve' })) } },
    );
    await drain(handleQueueItem, 50);
    return { spec, decision };
  }

  it('holds a sensitive item under the default posture, then runs it once confirmed', async () => {
    const { token } = await harness.signup();
    const { spec, decision } = await approveAll(token);

    const sensitive = spec.items.filter((item) => item.riskTier === 'sensitive');
    // The money item this note produces is sensitive, so "balanced" must hold it.
    expect(sensitive.length).toBeGreaterThan(0);
    expect(decision.body.awaitingConfirmation).toEqual(
      expect.arrayContaining(sensitive.map((item) => item.itemId)),
    );

    const confirm = await harness.request<{ runId: string; confirmed: number }>(
      'POST',
      `/v1/specs/${spec.specId}/confirm`,
      { token, body: { itemIds: sensitive.map((item) => item.itemId) } },
    );
    expect(confirm.status).toBe(202);

    const { drain } = await import('../queue/queue.js');
    const { handleQueueItem } = await import('../queue/worker.js');
    await drain(handleQueueItem, 50);

    const run = await harness.request<{ run: { items: { itemId: string; status: string }[] } }>(
      'GET',
      `/v1/runs/${confirm.body.runId}`,
      { token },
    );
    for (const item of sensitive) {
      const result = run.body.run.items.find((entry) => entry.itemId === item.itemId)!;
      expect(result.status).not.toBe('needs_input');
    }
  });

  it('leaves the trust posture untouched, so the next sensitive item is still held', async () => {
    const { token } = await harness.signup();
    const { spec } = await approveAll(token);
    const sensitive = spec.items.filter((item) => item.riskTier === 'sensitive');

    await harness.request(`POST`, `/v1/specs/${spec.specId}/confirm`, {
      token,
      body: { itemIds: sensitive.map((item) => item.itemId) },
    });

    const me = await harness.request<{ user: { preferences: { trustPosture: string } } }>('GET', '/v1/auth/me', {
      token,
    });
    expect(me.body.user.preferences.trustPosture).toBe('balanced');
  });

  it('refuses to confirm an item that was never approved', async () => {
    const { token } = await harness.signup();
    const capture = await harness.request<{ jobId: string }>('POST', '/v1/captures', {
      token,
      body: { kind: 'text', text: 'Cancel any subscription you have not opened in 90 days.' },
    });
    const { drain } = await import('../queue/queue.js');
    const { handleQueueItem } = await import('../queue/worker.js');
    await drain(handleQueueItem, 50);

    const { getSpecByJob } = await import('../repo/specs.js');
    const spec = getSpecByJob(capture.body.jobId);
    if (!spec || spec.items.length === 0) return;

    // Confirmation releases the trust gate; it is not a second route to approval.
    const response = await harness.request('POST', `/v1/specs/${spec.specId}/confirm`, {
      token,
      body: { itemIds: [spec.items[0]!.itemId] },
    });
    expect(response.status).toBe(400);
  });

  it('rejects confirming an item belonging to someone else', async () => {
    const owner = await harness.signup('owner@example.com');
    const stranger = await harness.signup('stranger@example.com');
    const { spec } = await approveAll(owner.token);

    const response = await harness.request('POST', `/v1/specs/${spec.specId}/confirm`, {
      token: stranger.token,
      body: { itemIds: [spec.items[0]!.itemId] },
    });
    expect(response.status).toBe(404);
  });
});

describe('instruction text', () => {
  it('writes the instruction itself, not the act of setting one', async () => {
    const { token, userId } = await harness.signup();
    await harness.request('POST', '/v1/captures', {
      token,
      body: {
        kind: 'text',
        // The leading "And" used to defeat the meta-strip, so the instructions
        // file ended up telling the assistant to set an instruction.
        text: 'And set a standing instruction to keep all summaries to five bullets.',
      },
    });

    const { drain } = await import('../queue/queue.js');
    const { handleQueueItem } = await import('../queue/worker.js');
    await drain(handleQueueItem, 50);

    const { getSpecByJob } = await import('../repo/specs.js');
    const { listJobs } = await import('../repo/jobs.js');
    const job = listJobs(userId)[0]!;
    const spec = getSpecByJob(job.jobId);
    const instruction = spec?.items.find((item) => item.type === 'set_instruction');
    if (!instruction) return;

    const text = String(instruction.parameters['instruction'] ?? '');
    expect(text).not.toMatch(/^and\b/i);
    expect(text.toLowerCase()).not.toContain('set a standing instruction');
    expect(text.toLowerCase()).toContain('five bullets');
  });
});
