import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import type { CaptureResponse, InputKind } from '@aiapp/shared';
import { CAPTURE_SOURCES, INPUT_KINDS, extractUrl, normalizeUrl, resolvePlatform, stripUrl } from '@aiapp/shared';
import { config } from '../../config.js';
import { assertWithinDailyBudget } from '../../implementation/guardrails.js';
import { asr } from '../../providers/asr.js';
import { vision } from '../../providers/vision.js';
import { enqueue } from '../../queue/queue.js';
import { audit } from '../../repo/audit.js';
import { createOrGetJob } from '../../repo/jobs.js';
import { badRequest } from '../../util/errors.js';
import { sha256 } from '../../util/ids.js';
import { createLogger, errorMessage } from '../../util/logger.js';
import { asyncHandler, currentUser, rateLimit, requireAuth } from '../middleware.js';

const log = createLogger('capture');

/**
 * Universal capture (spec §4.1b).
 *
 * The original app only accepted links, which quietly excluded most of what a
 * person actually encounters: a thought on the walk home, an overheard
 * recommendation, a poster, a paragraph in an email. This endpoint takes any of
 * those and reduces them to the same thing — text with provenance — so
 * everything downstream is unchanged.
 *
 * Voice and photo captures are decoded here rather than on the queue, because
 * both need the raw bytes and holding those in a queue payload would bloat the
 * database with megabytes per capture.
 */
export const capturesRouter = Router();
capturesRouter.use(requireAuth);

/** 10 MB, comfortably above a minute of voice memo or a phone photo. */
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

const captureSchema = z
  .object({
    kind: z.enum(INPUT_KINDS),
    url: z.string().max(4000).optional(),
    text: z.string().max(100_000).optional(),
    subject: z.string().max(500).optional(),
    media: z
      .object({
        data: z.string().min(1),
        mimeType: z.string().min(1).max(120),
        filename: z.string().max(255).optional(),
      })
      .optional(),
    note: z.string().max(1000).optional(),
    captureSource: z.enum(CAPTURE_SOURCES).optional(),
    clientRef: z.string().max(120).optional(),
  })
  .refine((body) => body.url || body.text || body.media, {
    message: 'A capture needs a link, some text, or a recording.',
  });

/**
 * POST /v1/captures — the one endpoint for everything a person encounters.
 *
 * Links return immediately and are processed on the queue. Voice and photo
 * captures are transcribed inline first, because the result determines whether
 * there is anything to process at all — and telling someone "I couldn't hear
 * that" straight away is far better than a job that silently ends in NO_ACTION.
 */
capturesRouter.post(
  '/',
  rateLimit({ capacity: 60, refillPerSecond: 1, key: 'capture' }),
  asyncHandler(async (req, res) => {
    const user = currentUser(req);
    const parsed = captureSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        'A capture needs a link, some text, or a recording.',
        parsed.error.flatten().fieldErrors,
      );
    }

    assertWithinDailyBudget(user.userId);

    const { kind } = parsed.data;
    const captureSource = parsed.data.captureSource ?? 'api';

    // ── link ────────────────────────────────────────────────────────────────
    if (kind === 'link') {
      const raw = (parsed.data.url ?? parsed.data.text ?? '').trim();
      const url = extractUrl(raw) ?? (/^https?:\/\//i.test(raw) ? raw : null);
      if (!url) {
        throw badRequest('No web link was found in what you shared. Paste the URL, or capture it as a note instead.');
      }

      const trailing = stripUrl(raw, url);
      const sharedText = [parsed.data.text, trailing, parsed.data.note].filter(Boolean).join('\n').trim() || null;

      const { job, deduped } = createOrGetJob({
        userId: user.userId,
        url,
        normalizedUrl: normalizeUrl(url),
        platform: resolvePlatform(url),
        sharedText,
        note: parsed.data.note ?? null,
        captureSource,
        inputKind: 'link',
      });

      if (!deduped) {
        enqueue({ jobId: job.jobId, kind: 'process' });
        audit({ userId: user.userId, jobId: job.jobId, event: 'capture.link', detail: captureSource });
      }
      const body: CaptureResponse = { jobId: job.jobId, state: job.state, deduped };
      res.status(deduped ? 200 : 202).json(body);
      return;
    }

    // ── text / email / voice / image ────────────────────────────────────────
    let bodyText = (parsed.data.text ?? '').trim();
    let title: string | null = parsed.data.subject?.trim() || null;

    if (kind === 'voice' || kind === 'image') {
      if (!parsed.data.media) throw badRequest(`A ${kind} capture needs a recording or a photo attached.`);
      const bytes = decodeMedia(parsed.data.media.data);
      if (!bytes) throw badRequest('That attachment could not be read.');
      if (bytes.length > MAX_MEDIA_BYTES) {
        throw badRequest(`That file is larger than ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} MB.`);
      }

      const extracted = await extractFromMedia({
        kind,
        bytes,
        mimeType: parsed.data.media.mimeType,
        filename: parsed.data.media.filename,
      });
      if (!extracted) {
        throw badRequest(
          kind === 'voice'
            ? 'Nothing could be heard in that recording. Try again somewhere quieter, or type it instead.'
            : 'No text could be read in that photo. Try a sharper shot, or type it instead.',
        );
      }
      // Anything typed alongside the media is context, not a replacement for it.
      bodyText = [extracted, bodyText].filter(Boolean).join('\n\n');
    }

    if (!bodyText) throw badRequest('That capture was empty.');

    // A synthetic URI keeps dedup, folder naming and the index working exactly
    // as they do for links, without pretending there is a web address.
    const contentHash = sha256(`${user.userId}:${bodyText}`).slice(0, 16);
    const syntheticUrl = `aiapp://${kind}/${contentHash}`;

    const { job, deduped } = createOrGetJob({
      userId: user.userId,
      url: syntheticUrl,
      normalizedUrl: syntheticUrl,
      platform: 'other',
      sharedText: null,
      note: parsed.data.note ?? null,
      captureSource,
      inputKind: kind,
      bodyText,
    });

    if (!deduped) {
      enqueue({ jobId: job.jobId, kind: 'process' });
      audit({
        userId: user.userId,
        jobId: job.jobId,
        event: `capture.${kind}`,
        detail: `${bodyText.length} chars · ${captureSource}`,
      });
    }

    const body: CaptureResponse = { jobId: job.jobId, state: job.state, deduped };
    res.status(deduped ? 200 : 202).json(body);
    void title;
  }),
);

/** Accepts both a bare base64 string and a `data:` URL from a browser FileReader. */
function decodeMedia(data: string): Buffer | null {
  try {
    const payload = data.startsWith('data:') ? (data.split(',', 2)[1] ?? '') : data;
    if (!payload) return null;
    const buffer = Buffer.from(payload, 'base64');
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

/**
 * Turns a recording or a photo into text using the same providers the link
 * pipeline uses, so a dictated note gets exactly the transcription quality a
 * video's audio track would.
 */
async function extractFromMedia(input: {
  kind: InputKind;
  bytes: Buffer;
  mimeType: string;
  filename?: string;
}): Promise<string | null> {
  const cfg = config();
  const scratch = path.join(cfg.storagePath, 'captures');
  await fs.mkdir(scratch, { recursive: true });

  const extension = extensionFor(input.mimeType, input.filename);
  const file = path.join(scratch, `${sha256(input.bytes.toString('base64')).slice(0, 24)}${extension}`);

  try {
    await fs.writeFile(file, input.bytes);

    if (input.kind === 'voice') {
      const result = await asr().transcribe(file);
      return result?.text?.trim() || null;
    }

    const { results } = await vision().read([{ index: 1, filePath: file }]);
    const text = results
      .map((page) => page.text.trim())
      .filter(Boolean)
      .join('\n');
    return text || null;
  } catch (err) {
    log.warn('media extraction failed', { kind: input.kind, error: errorMessage(err) });
    return null;
  } finally {
    // The transcript is what matters; the raw recording is not kept.
    await fs.rm(file, { force: true }).catch(() => {});
  }
}

function extensionFor(mimeType: string, filename?: string): string {
  const fromName = filename ? path.extname(filename) : '';
  if (fromName) return fromName.toLowerCase().slice(0, 8);
  const MAP: Record<string, string> = {
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/m4a': '.m4a',
    'audio/wav': '.wav',
    'audio/webm': '.webm',
    'audio/ogg': '.ogg',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/heic': '.heic',
  };
  return MAP[mimeType.toLowerCase()] ?? '.bin';
}
