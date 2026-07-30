import { describe, expect, it } from 'vitest';
import { extractUrl, folderNameFor, normalizeUrl, resolvePlatform, slugify, stripUrl } from '@aiapp/shared';
import { cleanCaptionText, cuesToSegments, dedupeCues, parseSubtitles, toVtt } from '../ingestion/subtitles.js';
import { normalize } from '../ingestion/normalizer.js';
import { htmlToText } from '../ingestion/fetcher.js';
import { classifyType, extractCandidateTips, titleFromTip } from '../analysis/heuristics.js';

/**
 * The extraction test corpus (spec §18 "Extraction test corpus").
 *
 * These cover the formats the waterfall actually has to survive: a captioned
 * video, an auto-captioned video with rolling-window duplication, a silent
 * carousel of text-on-image slides, and a thread whose advice is in the caption.
 */

describe('URL handling', () => {
  it('pulls a URL out of shared text the way the share sheet delivers it', () => {
    // Android's Web Share Target routinely puts the link in `text`, appended to
    // a caption — this is the single most common real-world capture shape.
    const shared = 'This trick is unreal 🤯 https://www.instagram.com/reel/Cabc123/?igshid=xyz check it';
    const url = extractUrl(shared);
    expect(url).toBe('https://www.instagram.com/reel/Cabc123/?igshid=xyz');
    expect(stripUrl(shared, url!)).toBe('This trick is unreal 🤯 check it');
  });

  it('strips trailing sentence punctuation from a URL', () => {
    expect(extractUrl('Watch https://youtu.be/abc123.')).toBe('https://youtu.be/abc123');
  });

  it('returns null when there is no link', () => {
    expect(extractUrl('just some text')).toBeNull();
    expect(extractUrl('')).toBeNull();
  });

  it('normalizes the same video shared three different ways to one URL', () => {
    const canonical = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    expect(normalizeUrl('https://youtu.be/dQw4w9WgXcQ?si=trackingcode')).toBe(canonical);
    expect(normalizeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(canonical);
    expect(normalizeUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share&utm_source=x')).toBe(canonical);
  });

  it('folds twitter.com and x.com together', () => {
    expect(normalizeUrl('https://twitter.com/user/status/123')).toBe(normalizeUrl('https://x.com/user/status/123'));
  });

  it('classifies every platform in the coverage matrix', () => {
    expect(resolvePlatform('https://www.youtube.com/shorts/abc')).toBe('youtube');
    expect(resolvePlatform('https://www.instagram.com/reel/abc/')).toBe('instagram');
    expect(resolvePlatform('https://vm.tiktok.com/ZMabc/')).toBe('tiktok');
    expect(resolvePlatform('https://x.com/u/status/1')).toBe('x');
    expect(resolvePlatform('https://www.linkedin.com/posts/abc')).toBe('linkedin');
    expect(resolvePlatform('https://fb.watch/abc/')).toBe('facebook');
    expect(resolvePlatform('https://example.com/blog')).toBe('other');
  });

  it('produces browsable folder names', () => {
    const name = folderNameFor('2026-07-30T21:04:00Z', 'instagram', 'Morning inbox summary!');
    expect(name).toBe('2026-07-30__instagram__morning-inbox-summary');
    expect(slugify('')).toBe('untitled');
  });
});

describe('subtitle parsing', () => {
  it('parses an author-provided WebVTT track', () => {
    const vtt = `WEBVTT

1
00:00:00.000 --> 00:00:04.000
Set a standing instruction so Claude keeps answers short.

2
00:00:04.000 --> 00:00:08.000
Then schedule it to run every morning at 7am.
`;
    const cues = parseSubtitles(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0]!.text).toContain('standing instruction');
    expect(cues[1]!.startSec).toBe(4);
  });

  it('collapses the rolling-window duplication of auto-captions', () => {
    // YouTube auto-captions repeat the previous line plus one new one. Left
    // alone this triples the transcript and inflates the item count.
    const cues = dedupeCues([
      { startSec: 0, endSec: 2, text: 'the first thing you do' },
      { startSec: 1, endSec: 3, text: 'the first thing you do is open' },
      { startSec: 2, endSec: 4, text: 'the first thing you do is open settings' },
    ]);
    expect(cues).toHaveLength(1);
    expect(cues[0]!.text).toBe('the first thing you do is open settings');
    expect(cues[0]!.endSec).toBe(4);
  });

  it('parses SRT timing with comma separators', () => {
    const srt = `1
00:00:01,500 --> 00:00:03,000
Pin the file to the top.
`;
    const cues = parseSubtitles(srt);
    expect(cues[0]!.startSec).toBeCloseTo(1.5);
  });

  it('strips caption artifacts and inline markup', () => {
    expect(cleanCaptionText('[Music] Turn on memory [Applause]')).toBe('Turn on memory');
    const cues = parseSubtitles('WEBVTT\n\n00:00.000 --> 00:02.000 align:start\n<c.colorE5E5E5>Use a skill</c>\n');
    expect(cues[0]!.text).toBe('Use a skill');
  });

  it('groups cues into sentence-sized segments and round-trips to VTT', () => {
    const cues = cuesToSegments([
      { startSec: 0, endSec: 1, text: 'First do this.' },
      { startSec: 1, endSec: 2, text: 'Then do that.' },
    ]);
    expect(cues.length).toBeGreaterThan(0);
    expect(toVtt(cues)).toMatch(/^WEBVTT/);
  });
});

describe('content normalization', () => {
  it('deduplicates the same tip arriving from caption, audio and OCR', () => {
    // The archetypal Reel: text burned into the video, spoken aloud, and
    // repeated in the caption. Without dedupe the analyzer sees three tips.
    const result = normalize({
      segments: [
        { order: 0, text: 'Set a standing instruction to keep answers short', provenance: 'post_description', confidence: 1 },
        { order: 1, text: 'set a standing instruction to keep answers short!', provenance: 'asr_whisper', confidence: 0.88 },
        { order: 2, text: 'SLIDE 1: Set a standing instruction to keep answers short', provenance: 'ocr_multimodal', confidence: 0.95 },
        { order: 3, text: 'Then schedule it for every morning at seven', provenance: 'asr_whisper', confidence: 0.88 },
      ],
    });

    expect(result.segments).toHaveLength(2);
    expect(result.segments.map((s) => s.order)).toEqual([0, 1]);
    expect(result.mergedText).toContain('[0]');
  });

  it('weights confidence by segment length', () => {
    const result = normalize({
      segments: [
        { order: 0, text: 'x'.repeat(500), provenance: 'author_caption', confidence: 0.99 },
        { order: 1, text: 'short', provenance: 'ocr_tesseract', confidence: 0.2 },
      ],
    });
    // The long high-confidence block should dominate.
    expect(result.overallConfidence).toBeGreaterThan(0.95);
    expect(result.lowConfidence).toBe(false);
  });

  it('flags thin extractions from lossy sources as low confidence', () => {
    const result = normalize({
      segments: [{ order: 0, text: 'nice video', provenance: 'asr_whisper', confidence: 0.6 }],
    });
    expect(result.lowConfidence).toBe(true);
  });

  it('does not cry wolf over a short but verbatim caption', () => {
    // The flag offers "re-run with a stronger method". For text we read
    // verbatim at full confidence, there is nothing stronger to try — the post
    // was simply short, and warning about it trains the user to ignore the flag.
    const result = normalize({
      segments: [
        {
          order: 0,
          text: 'Add a standing instruction to always keep answers to five bullets.',
          provenance: 'post_description',
          confidence: 1,
        },
      ],
    });
    expect(result.lowConfidence).toBe(false);
  });

  it('still flags a short OCR read, where a stronger method could help', () => {
    const result = normalize({
      segments: [{ order: 0, text: 'Turn on memory', provenance: 'ocr_tesseract', confidence: 0.82 }],
    });
    expect(result.lowConfidence).toBe(true);
  });

  it('flags an empty extraction rather than pretending it succeeded', () => {
    const result = normalize({ segments: [] });
    expect(result.segments).toHaveLength(0);
    expect(result.lowConfidence).toBe(true);
    expect(result.overallConfidence).toBe(0);
  });

  it('preserves carousel slide order', () => {
    const result = normalize({
      segments: [
        { order: 0, text: 'SLIDE 1: Open your settings', provenance: 'ocr_multimodal', confidence: 0.95, frameIndex: 1 },
        { order: 1, text: 'SLIDE 2: Turn on project memory', provenance: 'ocr_multimodal', confidence: 0.95, frameIndex: 2 },
        { order: 2, text: 'SLIDE 3: Add a standing instruction', provenance: 'ocr_multimodal', confidence: 0.95, frameIndex: 3 },
      ],
    });
    expect(result.segments.map((s) => s.text)).toEqual([
      'SLIDE 1: Open your settings',
      'SLIDE 2: Turn on project memory',
      'SLIDE 3: Add a standing instruction',
    ]);
  });
});

describe('page text extraction', () => {
  it('reduces markup to visible prose', () => {
    const html = `<html><head><style>.a{color:red}</style><script>var x=1</script></head>
      <body><nav>Home</nav><p>Give Claude a standing instruction to always cite sources.</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('standing instruction');
    expect(text).not.toContain('var x');
    expect(text).not.toContain('color:red');
  });
});

describe('rule-based insight extraction (offline analyzer)', () => {
  const merged = [
    '[0] (post caption) Here is how to make Claude summarize your inbox every morning.',
    '[1] (author captions @00:03) Create a reusable skill that reads your inbox and writes five bullets.',
    '[2] (author captions @00:09) Then schedule it to run every morning at 7am so it happens automatically.',
    '[3] (author captions @00:14) Follow me for more tips and comment below!',
  ].join('\n');

  it('extracts the real tips and ignores engagement bait', () => {
    const tips = extractCandidateTips(merged);
    expect(tips.length).toBeGreaterThanOrEqual(2);
    const joined = tips.map((tip) => tip.text.toLowerCase()).join(' ');
    expect(joined).toContain('skill');
    expect(joined).toContain('schedule');
    expect(joined).not.toContain('follow me');
  });

  it('classifies advice into the right item types', () => {
    expect(classifyType('Schedule it to run every morning at 7am')).toBe('schedule_task');
    expect(classifyType('Create a reusable skill for this workflow')).toBe('create_skill');
    expect(classifyType('Add a standing instruction to always cite sources')).toBe('set_instruction');
    expect(classifyType('Connect your Gmail so it can read your inbox')).toBe('connect_tool');
    expect(classifyType('Download the prompt pack from the link')).toBe('download_file');
  });

  it('produces short imperative titles', () => {
    expect(titleFromTip('You should create a reusable skill that reads your inbox.')).toBe(
      'Create a reusable skill that reads your inbox',
    );
    expect(titleFromTip('1. Make sure to turn on memory')).toBe('Turn on memory');
    expect(titleFromTip('').length).toBeGreaterThan(0);
  });

  it('drops the post’s own headline instead of turning it into an item', () => {
    // "Here's how to X" announces the advice; the advice is the next sentence.
    // Scored naively it wins on every signal and duplicates the real tip.
    const tips = extractCandidateTips(merged);
    expect(tips.some((tip) => /^here is how/i.test(tip.text))).toBe(false);
  });

  it('presents tips in source order, not score order', () => {
    // Advice is usually sequential; showing step 3 above step 1 because it
    // scored higher makes the plan unreadable.
    const tips = extractCandidateTips(merged);
    const skillIndex = tips.findIndex((tip) => /reusable skill/i.test(tip.text));
    const scheduleIndex = tips.findIndex((tip) => /schedule/i.test(tip.text));
    expect(skillIndex).toBeGreaterThanOrEqual(0);
    expect(scheduleIndex).toBeGreaterThan(skillIndex);
  });

  it('sees the imperative behind a leading connective', () => {
    const tips = extractCandidateTips(
      '[0] (post caption) Also add a standing instruction to always keep answers to five bullets.',
    );
    expect(tips).toHaveLength(1);
    expect(tips[0]!.type).toBe('set_instruction');
    // And the connective does not survive into the title.
    expect(titleFromTip(tips[0]!.text)).toBe('Add a standing instruction to always keep answers to five bullets');
  });

  it('handles numbered step lists', () => {
    const tips = extractCandidateTips(
      [
        '[0] (on-screen text) 1. Create a reusable skill for your standup notes',
        '[1] (on-screen text) 2. Connect your Slack so it can post the update',
        '[2] (on-screen text) 3. Schedule it every weekday at 9am',
      ].join('\n'),
    );
    expect(tips).toHaveLength(3);
    expect(tips.map((tip) => tip.type)).toEqual(['create_skill', 'connect_tool', 'schedule_task']);
    expect(titleFromTip(tips[0]!.text)).toBe('Create a reusable skill for your standup notes');
  });

  it('does not treat an adjective as a schedule', () => {
    // "weekly review" describes what the thing is, not when it runs.
    expect(classifyType('Create a reusable skill that drafts your weekly review')).toBe('create_skill');
    expect(classifyType('Run it every Friday at 4pm')).toBe('schedule_task');
  });

  it('finds nothing actionable in pure entertainment — and does not invent it', () => {
    // BRD use case 9.4: the correct answer is an empty list, not a fabricated tip.
    const entertainment = [
      '[0] (post caption) POV: when the code compiles on the first try 😂',
      '[1] (author captions @00:02) Nah bro that never happens.',
      '[2] (author captions @00:05) Anyway follow for more.',
    ].join('\n');
    expect(extractCandidateTips(entertainment)).toHaveLength(0);
  });
});
