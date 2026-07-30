import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ITEM_TYPE_SCOPES, renderMarkdown } from '@aiapp/shared';
import { cronMatches, describeCron, isValidCron, nextRunFor, parseCron } from '../implementation/cron.js';
import { buildZip } from '../util/zip.js';
import { parseJsonLoose } from '../providers/llm.js';
import { analyze } from '../analysis/analyzer.js';
import { createHarness, clearProviderStubs, stubLlm, type Harness } from './harness.js';

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  clearProviderStubs();
  await harness.close();
});

describe('cron', () => {
  it('parses the expressions tips actually produce', () => {
    expect(isValidCron('0 7 * * *')).toBe(true);
    expect(isValidCron('30 16 * * 5')).toBe(true);
    expect(isValidCron('0 */4 * * *')).toBe(true);
    expect(isValidCron('0 9 * * 1-5')).toBe(true);
    expect(isValidCron('0 9 * * 7')).toBe(true); // 7 aliases Sunday
    expect(isValidCron('nonsense')).toBe(false);
    expect(isValidCron('0 25 * * *')).toBe(false);
    expect(isValidCron('0 7 * *')).toBe(false);
  });

  it('computes the next run strictly after the given moment', () => {
    const from = new Date('2026-07-30T06:59:00Z');
    expect(nextRunFor('0 7 * * *', from)).toBe('2026-07-30T07:00:00.000Z');
    // Already past today, so it rolls to tomorrow.
    expect(nextRunFor('0 7 * * *', new Date('2026-07-30T07:00:00Z'))).toBe('2026-07-31T07:00:00.000Z');
  });

  it('honours day-of-week restrictions', () => {
    // 2026-07-31 is a Friday.
    expect(nextRunFor('0 16 * * 5', new Date('2026-07-30T00:00:00Z'))).toBe('2026-07-31T16:00:00.000Z');
  });

  it('matches with standard day-field semantics', () => {
    const fields = parseCron('0 7 * * 1-5')!;
    expect(cronMatches(fields, new Date('2026-07-30T07:00:00Z'))).toBe(true); // Thursday
    expect(cronMatches(fields, new Date('2026-08-01T07:00:00Z'))).toBe(false); // Saturday
  });

  it('describes a schedule in plain language', () => {
    expect(describeCron('0 7 * * *')).toBe('every day at 07:00 UTC');
    expect(describeCron('30 16 * * 5')).toBe('every Friday at 16:30 UTC');
    expect(describeCron('0 9 * * 1-5')).toBe('every weekday at 09:00 UTC');
    expect(describeCron('garbage')).toBe('garbage');
  });

  it('returns null for a date that can never occur', () => {
    expect(nextRunFor('0 0 30 2 *')).toBeNull();
  });
});

describe('zip writer', () => {
  it('produces a well-formed archive', () => {
    const archive = buildZip([
      { path: 'folder/03_summary.md', content: Buffer.from('# Summary\n\nSome text.') },
      { path: 'folder/00_source.json', content: Buffer.from(JSON.stringify({ a: 1 })) },
    ]);

    // Local file header, central directory, and end-of-central-directory records.
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    expect(archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))).toBeGreaterThan(0);
    const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(eocd).toBeGreaterThan(0);
    expect(archive.readUInt16LE(eocd + 10)).toBe(2); // entry count
  });

  it('handles an empty archive without corrupting the trailer', () => {
    const archive = buildZip([]);
    expect(archive.readUInt32LE(0)).toBe(0x06054b50);
    expect(archive.byteLength).toBe(22);
  });
});

describe('lenient JSON parsing', () => {
  it('recovers JSON from the shapes models actually return', () => {
    expect(parseJsonLoose<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose<{ a: number }>('Sure! Here you go:\n{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('not json at all')).toBeNull();
    expect(parseJsonLoose('')).toBeNull();
  });
});

describe('analyzer with a model', () => {
  it('assigns scopes server-side and ignores what the model claims', async () => {
    const { userId } = await harness.signup();

    // The response asks for a privileged type it should not get to define, and
    // its own scope list is irrelevant — scopes come from the item type.
    stubLlm(
      JSON.stringify({
        title: 'Morning inbox summary',
        summary: 'The post shows how to have Claude summarize your inbox each morning.',
        noActionableItems: false,
        items: [
          {
            title: 'Create a morning inbox summary skill',
            type: 'create_skill',
            why: 'Automates a task you do manually',
            proposedMethod: 'Define a skill',
            prerequisites: ['email connector'],
            effort: 'low',
            impact: 'high',
            requiresBrowser: false,
            sourceSegments: [0, 1],
            parameters: { name: 'morning-inbox', description: 'x', body: '# Morning inbox\n\nSteps…' },
            scopes: ['shell:exec', 'connectors:write'],
          },
          {
            title: 'Schedule it for 7am daily',
            type: 'schedule_task',
            why: 'Makes it happen without you',
            proposedMethod: 'Register a scheduled task',
            prerequisites: [],
            effort: 'low',
            impact: 'high',
            sourceSegments: [2],
            parameters: { name: 'morning-inbox', cron: '0 7 * * *', timezone: 'UTC', description: 'x' },
          },
        ],
      }),
    );

    const result = await analyze({
      userId,
      mergedText: '[0] (post caption) Have Claude summarize your inbox every morning.',
      platform: 'instagram',
      url: 'https://www.instagram.com/reel/x/',
      lowConfidence: false,
      overallConfidence: 0.95,
    });

    expect(result.analyzer).toBe('claude');
    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.scopes).toEqual(ITEM_TYPE_SCOPES.create_skill);
    expect(result.items[0]!.scopes).not.toContain('shell:exec');
    expect(result.items[1]!.type).toBe('schedule_task');
    expect(result.items[1]!.riskTier).toBe('moderate');
    // The prerequisite gap is computed from this user's connectors, not the model.
    expect(result.items[0]!.missingPrerequisites).toContain('email connector');
    expect(result.usage.usd).toBeGreaterThan(0);
  });

  it('falls back to the offline analyzer when the model returns nonsense', async () => {
    const { userId } = await harness.signup();
    stubLlm('I am terribly sorry, I cannot help with that.');

    const result = await analyze({
      userId,
      mergedText:
        '[0] (author captions) Create a reusable skill that drafts your standup notes.\n' +
        '[1] (author captions) Schedule it to run every morning at 8am.',
      platform: 'youtube',
      url: 'https://www.youtube.com/watch?v=x',
      lowConfidence: false,
      overallConfidence: 0.99,
    });

    expect(result.analyzer).toBe('offline');
    expect(result.items.length).toBeGreaterThan(0);
  });

  it('honours a model saying there is nothing actionable', async () => {
    const { userId } = await harness.signup();
    stubLlm(
      JSON.stringify({
        title: 'A joke about compilers',
        summary: 'This is a joke, not advice. Nothing to set up.',
        noActionableItems: true,
        items: [],
      }),
    );

    const result = await analyze({
      userId,
      mergedText: '[0] (post caption) POV: the code compiles first try',
      platform: 'instagram',
      url: 'https://www.instagram.com/reel/y/',
      lowConfidence: false,
      overallConfidence: 0.9,
    });

    expect(result.noActionableItems).toBe(true);
    expect(result.items).toHaveLength(0);
  });
});

describe('markdown rendering', () => {
  it('escapes HTML in model-authored content', () => {
    // Spec and summary text is written by a model and rendered into the review
    // UI with dangerouslySetInnerHTML, so escaping is a security property.
    const html = renderMarkdown('<img src=x onerror=alert(1)> and **bold**');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<strong>bold</strong>');
  });

  it('refuses to build anchors for non-http schemes', () => {
    const html = renderMarkdown('[click me](javascript:alert(1)) and [ok](https://example.com)');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('href="https://example.com"');
  });

  it('renders the structures the spec artifact uses', () => {
    const html = renderMarkdown(
      ['# Title', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', '', '- first', '- second', '', '```json', '{"a":1}', '```'].join(
        '\n',
      ),
    );
    expect(html).toContain('<h2>Title</h2>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<td>1</td>');
    expect(html).toContain('<li>first</li>');
    expect(html).toContain('<pre><code>');
  });
});
