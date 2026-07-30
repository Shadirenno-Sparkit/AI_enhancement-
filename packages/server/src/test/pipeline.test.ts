import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ARTIFACT_FILES, INDEX_FILE } from '@aiapp/shared';
import { createHarness, clearProviderStubs, stubAsr, stubVision, type Harness } from './harness.js';
import { drain } from '../queue/queue.js';
import { handleQueueItem } from '../queue/worker.js';
import { getSpecByJob } from '../repo/specs.js';
import { getJobUnscoped } from '../repo/jobs.js';
import { saveInsightSource } from '../repo/insights.js';
import { processJob } from '../orchestrator/pipeline.js';
import { createOrGetJob } from '../repo/jobs.js';

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  clearProviderStubs();
  await harness.close();
});

/** Runs the queue to completion the way the worker would. */
async function runQueue(): Promise<void> {
  await drain(handleQueueItem, 50);
}

describe('capture → spec → approve → implement', () => {
  it('captures a link, files artifacts, and reaches a reviewable state', async () => {
    const { token, userId } = await harness.signup();

    const capture = await harness.request<{ jobId: string; deduped: boolean }>('POST', '/v1/links', {
      token,
      body: {
        // A caption-carried tip: no network fetch needed for the advice itself,
        // which is exactly the Instagram/LinkedIn shape from the coverage matrix.
        url: 'https://www.instagram.com/reel/TESTabc123/',
        sharedText:
          'Here is how to make Claude summarize your inbox every morning. ' +
          'Create a reusable skill that reads your inbox and writes five bullets. ' +
          'Then schedule it to run every morning at 7am so it happens automatically.',
        captureSource: 'share_target',
      },
    });

    expect(capture.status).toBe(202);
    expect(capture.body.deduped).toBe(false);
    const { jobId } = capture.body;

    await runQueue();

    const job = getJobUnscoped(jobId)!;
    expect(['SPEC_READY', 'NO_ACTION']).toContain(job.state);
    expect(job.folderName).toBeTruthy();

    const spec = getSpecByJob(jobId);
    expect(spec).not.toBeNull();
    expect(spec!.items.length).toBeGreaterThan(0);

    // Every artifact the spec's folder layout promises (§11.1).
    const folder = path.join(harness.dir, 'artifacts', userId, job.folderName!);
    for (const file of [
      ARTIFACT_FILES.source,
      ARTIFACT_FILES.transcriptTxt,
      ARTIFACT_FILES.insights,
      ARTIFACT_FILES.summary,
      ARTIFACT_FILES.spec,
    ]) {
      expect(fs.existsSync(path.join(folder, file)), `expected ${file}`).toBe(true);
    }
    expect(fs.existsSync(path.join(folder, 'artifacts'))).toBe(true);

    // The folder is named from the derived title, not the generic placeholder
    // it was created with before analysis ran (BR-F3).
    expect(job.folderName).toMatch(/^\d{4}-\d{2}-\d{2}__instagram__/);
    expect(job.folderName).not.toMatch(/instagram-post$/);

    // The top-level index lists it (BR-F4).
    const index = fs.readFileSync(path.join(harness.dir, 'artifacts', userId, INDEX_FILE), 'utf8');
    expect(index).toContain(job.folderName!);

    // 00_source.json records provenance of the capture itself.
    const source = JSON.parse(fs.readFileSync(path.join(folder, ARTIFACT_FILES.source), 'utf8')) as {
      captureSource: string;
      url: string;
    };
    expect(source.captureSource).toBe('share_target');
  });

  it('runs the full approve → implement loop and writes the run log', async () => {
    const { token, userId } = await harness.signup();

    const capture = await harness.request<{ jobId: string }>('POST', '/v1/links', {
      token,
      body: {
        url: 'https://www.youtube.com/watch?v=TESTxyz789',
        sharedText:
          'Create a reusable skill that drafts your weekly update. ' +
          'Add a standing instruction to always keep summaries to five bullets.',
      },
    });
    await runQueue();

    const spec = getSpecByJob(capture.body.jobId)!;
    expect(spec.items.length).toBeGreaterThanOrEqual(1);

    // Approve everything, live (not a preview).
    const decision = await harness.request<{ runId: string; awaitingConfirmation: string[] }>(
      'POST',
      `/v1/specs/${spec.specId}/decisions`,
      {
        token,
        body: { items: spec.items.map((item) => ({ itemId: item.itemId, decision: 'approve' })) },
      },
    );
    expect(decision.status).toBe(202);
    expect(decision.body.runId).toBeTruthy();

    await runQueue();

    const run = await harness.request<{ run: { status: string; items: { status: string }[] } }>(
      'GET',
      `/v1/runs/${decision.body.runId}`,
      { token },
    );
    expect(run.status).toBe(200);
    expect(['done', 'partial', 'needs_input']).toContain(run.body.run.status);
    expect(run.body.run.items.length).toBeGreaterThan(0);

    const job = getJobUnscoped(capture.body.jobId)!;
    const folder = path.join(harness.dir, 'artifacts', userId, job.folderName!);
    expect(fs.existsSync(path.join(folder, ARTIFACT_FILES.runLog))).toBe(true);
    expect(fs.existsSync(path.join(folder, ARTIFACT_FILES.decisions))).toBe(true);

    // Something concrete must have been produced — the whole point of the run.
    const produced = fs.readdirSync(path.join(folder, 'artifacts'));
    expect(produced.length).toBeGreaterThan(0);
  });

  it('folds a duplicate share into the original job', async () => {
    const { token } = await harness.signup();
    const body = { url: 'https://www.tiktok.com/@u/video/12345', sharedText: 'Turn on memory in settings.' };

    const first = await harness.request<{ jobId: string; deduped: boolean }>('POST', '/v1/links', { token, body });
    // Same video, different tracking params and a different host alias.
    const second = await harness.request<{ jobId: string; deduped: boolean }>('POST', '/v1/links', {
      token,
      body: { ...body, url: 'https://m.tiktok.com/@u/video/12345?is_from_webapp=1&sender_device=pc' },
    });

    expect(second.body.deduped).toBe(true);
    expect(second.body.jobId).toBe(first.body.jobId);
  });

  it('reports plainly when nothing can be extracted, and fabricates nothing', async () => {
    const { token } = await harness.signup();
    // A domain that resolves to nothing: no captions, no audio, no page text.
    const capture = await harness.request<{ jobId: string }>('POST', '/v1/links', {
      token,
      body: { url: 'https://invalid.invalid/definitely-not-a-real-post' },
    });
    await runQueue();

    const job = getJobUnscoped(capture.body.jobId)!;
    expect(['NO_ACTION', 'FAILED']).toContain(job.state);
    expect(job.statusMessage).toBeTruthy();

    const spec = getSpecByJob(capture.body.jobId);
    // Either no spec at all, or a spec that honestly says there is nothing.
    if (spec) expect(spec.items).toHaveLength(0);
  });

  it('returns no items for pure entertainment rather than inventing advice', async () => {
    const { token } = await harness.signup();
    const capture = await harness.request<{ jobId: string }>('POST', '/v1/links', {
      token,
      body: {
        url: 'https://www.instagram.com/reel/ENTERTAINMENT1/',
        sharedText: 'POV: when the code compiles first try 😂 nah that never happens. Follow for more!',
      },
    });
    await runQueue();

    const spec = getSpecByJob(capture.body.jobId);
    if (spec) {
      expect(spec.items).toHaveLength(0);
      expect(spec.noActionableItems).toBe(true);
    }
    expect(getJobUnscoped(capture.body.jobId)!.state).toBe('NO_ACTION');
  });

  it('reads a text-on-image carousel through the vision path', async () => {
    // Use case 9.2: six slides, no audio, no captions. The spec must reflect
    // content from the slides, in order.
    stubVision([
      { index: 1, text: 'Step 1: Open your assistant settings' },
      { index: 2, text: 'Step 2: Create a reusable skill for your weekly report' },
      { index: 3, text: 'Step 3: Schedule it every Friday at 4pm' },
    ]);

    const { token, userId } = await harness.signup();
    const { job } = createOrGetJob({
      userId,
      url: 'https://www.linkedin.com/posts/carousel-test',
      normalizedUrl: 'https://www.linkedin.com/posts/carousel-test',
      platform: 'linkedin',
      captureSource: 'paste',
    });

    // Drive the transcript stage directly with pre-fetched frames — this
    // isolates the vision path from network availability.
    const { runTranscriptWaterfall } = await import('../ingestion/transcript.js');
    const frameDir = path.join(harness.dir, 'frames');
    fs.mkdirSync(frameDir, { recursive: true });
    const frames = ['a.jpg', 'b.jpg', 'c.jpg'].map((name) => {
      const file = path.join(frameDir, name);
      fs.writeFileSync(file, 'not-a-real-image');
      return file;
    });

    const result = await runTranscriptWaterfall({
      media: { subtitleFiles: [], imagePaths: frames, methods: [] },
      platform: 'linkedin',
    });

    expect(result.segments.map((segment) => segment.text)).toEqual([
      'SLIDE 1: Step 1: Open your assistant settings',
      'SLIDE 2: Step 2: Create a reusable skill for your weekly report',
      'SLIDE 3: Step 3: Schedule it every Friday at 4pm',
    ]);
    expect(result.methodsUsed).toContain('ocr_multimodal');
    expect(token).toBeTruthy();
    expect(job.jobId).toBeTruthy();
  });

  it('falls back to speech-to-text when no caption track exists', async () => {
    // Use case 9.3: a TikTok with audio only. The result must be tagged as
    // machine-transcribed so the confidence is visible to the user.
    stubAsr('Set a standing instruction so Claude always cites its sources.', 42);

    const { runTranscriptWaterfall } = await import('../ingestion/transcript.js');
    const audioPath = path.join(harness.dir, 'audio.mp3');
    fs.writeFileSync(audioPath, 'not-real-audio');

    const result = await runTranscriptWaterfall({
      media: { subtitleFiles: [], imagePaths: [], audioPath, methods: [] },
      platform: 'tiktok',
    });

    expect(result.segments.length).toBeGreaterThan(0);
    expect(result.methodsUsed).toContain('asr_whisper');
    expect(result.cost.asrSeconds).toBe(42);
    expect(result.cost.usd).toBeGreaterThan(0);
  });

  it('prefers author captions over auto captions', async () => {
    const { runTranscriptWaterfall } = await import('../ingestion/transcript.js');
    const authorTrack = path.join(harness.dir, 'author.en.vtt');
    fs.writeFileSync(
      authorTrack,
      'WEBVTT\n\n00:00.000 --> 00:04.000\nCreate a reusable skill for your morning review.\n',
    );

    const result = await runTranscriptWaterfall({
      media: {
        subtitleFiles: [{ filePath: authorTrack, language: 'en', auto: false }],
        imagePaths: [],
        methods: [],
      },
      platform: 'youtube',
    });

    expect(result.methodsUsed).toContain('author_caption');
    expect(result.segments[0]!.confidence).toBeGreaterThan(0.95);
    expect(result.vtt).toMatch(/^WEBVTT/);
  });

  it('resumes cleanly when the same job is processed twice', async () => {
    // Idempotency: a retry after a crash must not duplicate specs or folders.
    const { token, userId } = await harness.signup();
    const capture = await harness.request<{ jobId: string }>('POST', '/v1/links', {
      token,
      body: {
        url: 'https://www.instagram.com/reel/IDEMPOTENT1/',
        sharedText: 'Create a reusable skill that drafts your standup update every morning.',
      },
    });
    await runQueue();

    const firstSpec = getSpecByJob(capture.body.jobId)!;
    await processJob(capture.body.jobId);
    const secondSpec = getSpecByJob(capture.body.jobId)!;

    // A new spec row replaces the old one rather than accumulating.
    expect(secondSpec.jobId).toBe(firstSpec.jobId);
    const userFolders = fs
      .readdirSync(path.join(harness.dir, 'artifacts', userId), { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    expect(userFolders).toHaveLength(1);
  });

  it('exports the whole folder as a usable zip', async () => {
    const { token } = await harness.signup();
    await harness.request('POST', '/v1/links', {
      token,
      body: {
        url: 'https://www.youtube.com/watch?v=EXPORTTEST',
        sharedText: 'Add a standing instruction to always summarize in five bullets.',
      },
    });
    await runQueue();

    const zip = await harness.request('GET', '/v1/artifacts/export/all', { token });
    expect(zip.status).toBe(200);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(zip.headers.get('content-disposition')).toContain('AI-Enhancement-App.zip');
    // A real archive, not an empty response.
    expect(Number(zip.headers.get('content-length'))).toBeGreaterThan(200);
  });
});

describe('extraction cache', () => {
  it('reuses a previous extraction for the same URL', async () => {
    const { token, userId } = await harness.signup();

    const first = await harness.request<{ jobId: string }>('POST', '/v1/links', {
      token,
      body: {
        url: 'https://www.instagram.com/reel/CACHEDLINK/',
        sharedText: 'Create a reusable skill that reviews your calendar every morning.',
      },
    });
    await runQueue();

    // A second user sharing the same link reuses the cached extraction — the
    // cache is content-addressed, not user-scoped (spec §6.5).
    const other = await harness.signup('other@example.com');
    const second = await harness.request<{ jobId: string }>('POST', '/v1/links', {
      token: other.token,
      body: { url: 'https://www.instagram.com/reel/CACHEDLINK/?igshid=different' },
    });
    await runQueue();

    const secondJob = getJobUnscoped(second.body.jobId)!;
    expect(secondJob.state).toBe('SPEC_READY');
    expect(getSpecByJob(second.body.jobId)!.items.length).toBeGreaterThan(0);
    // Cached: the second job pays nothing for extraction.
    expect(secondJob.cost.asrSeconds).toBe(0);
    expect(first.body.jobId).not.toBe(second.body.jobId);
    expect(userId).not.toBe(other.userId);
  });
});

describe('insight source persistence', () => {
  it('stores and returns segments with provenance intact', async () => {
    const { userId } = await harness.signup();
    const { job } = createOrGetJob({
      userId,
      url: 'https://example.com/x',
      normalizedUrl: 'https://example.com/x',
      platform: 'other',
      captureSource: 'api',
    });

    const saved = saveInsightSource({
      jobId: job.jobId,
      userId,
      segments: [{ order: 0, text: 'hello', provenance: 'author_caption', confidence: 0.99 }],
      postDescription: null,
      language: 'en',
      durationSec: 12,
      overallConfidence: 0.99,
      lowConfidence: false,
      methodsUsed: ['author_caption'],
    });

    expect(saved.segments[0]!.provenance).toBe('author_caption');
    expect(saved.durationSec).toBe(12);
  });
});
