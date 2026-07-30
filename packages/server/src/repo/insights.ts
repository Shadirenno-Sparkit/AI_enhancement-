import type { InsightSegment, InsightSource, Provenance } from '@aiapp/shared';
import { db, now, parseJson } from '../db/index.js';
import { id } from '../util/ids.js';

interface SourceRow {
  insight_source_id: string;
  job_id: string;
  user_id: string;
  segments: string;
  post_description: string | null;
  language: string;
  duration_sec: number | null;
  overall_confidence: number;
  low_confidence: number;
  methods_used: string;
  created_at: string;
}

function toSource(row: SourceRow): InsightSource {
  return {
    insightSourceId: row.insight_source_id,
    jobId: row.job_id,
    segments: parseJson<InsightSegment[]>(row.segments, []),
    postDescription: row.post_description,
    language: row.language,
    durationSec: row.duration_sec,
    overallConfidence: row.overall_confidence,
    lowConfidence: row.low_confidence === 1,
    methodsUsed: parseJson<Provenance[]>(row.methods_used, []),
    createdAt: row.created_at,
  };
}

export function saveInsightSource(
  input: Omit<InsightSource, 'insightSourceId' | 'createdAt'> & { userId: string },
): InsightSource {
  const sourceId = id('src');
  const database = db();
  const save = database.transaction(() => {
    // A re-run replaces the previous extraction for the job.
    database.prepare('DELETE FROM insight_sources WHERE job_id = ?').run(input.jobId);
    database
      .prepare(
        `INSERT INTO insight_sources (insight_source_id, job_id, user_id, segments, post_description,
                                      language, duration_sec, overall_confidence, low_confidence,
                                      methods_used, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sourceId,
        input.jobId,
        input.userId,
        JSON.stringify(input.segments),
        input.postDescription ?? null,
        input.language,
        input.durationSec ?? null,
        input.overallConfidence,
        input.lowConfidence ? 1 : 0,
        JSON.stringify(input.methodsUsed),
        now(),
      );
  });
  save();
  return getInsightSourceByJob(input.jobId)!;
}

export function getInsightSourceByJob(jobId: string): InsightSource | null {
  const row = db().prepare('SELECT * FROM insight_sources WHERE job_id = ?').get(jobId) as SourceRow | undefined;
  return row ? toSource(row) : null;
}

// ─── Content-addressed extraction cache (spec §6.5) ──────────────────────────

export function cacheGet<T>(contentHash: string): T | null {
  const row = db()
    .prepare('SELECT payload FROM extraction_cache WHERE content_hash = ?')
    .get(contentHash) as { payload: string } | undefined;
  return row ? parseJson<T | null>(row.payload, null) : null;
}

export function cacheSet(contentHash: string, payload: unknown): void {
  db()
    .prepare('INSERT OR REPLACE INTO extraction_cache (content_hash, payload, created_at) VALUES (?, ?, ?)')
    .run(contentHash, JSON.stringify(payload), now());
}
