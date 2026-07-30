import type { Job, JobState, LibraryEntry } from '@aiapp/shared';
import { PLATFORM_LABELS } from '@aiapp/shared';
import { writeIndex, type IndexEntry } from '../artifacts/fileManager.js';
import { getInsightSourceByJob } from '../repo/insights.js';
import { listJobs } from '../repo/jobs.js';
import { latestRunForSpec } from '../repo/runs.js';
import { getSpecByJob, listDecisions } from '../repo/specs.js';

/** Plain-language status shown in `_index.md` and the library view. */
const STATE_LABELS: Record<JobState, string> = {
  RECEIVED: 'queued',
  RESOLVED: 'processing',
  FETCHED: 'processing',
  TRANSCRIBED: 'processing',
  NORMALIZED: 'processing',
  ANALYZED: 'processing',
  SPEC_READY: 'spec ready',
  AWAITING_DECISION: 'spec ready',
  IMPLEMENTING: 'implementing',
  DONE: 'implemented',
  PARTIAL: 'partly implemented',
  NEEDS_INPUT: 'needs you',
  NO_ACTION: 'no action',
  FAILED: 'failed',
};

export function libraryEntryFor(job: Job): LibraryEntry {
  const spec = getSpecByJob(job.jobId);
  const decisions = spec ? listDecisions(spec.specId) : [];
  const run = spec ? latestRunForSpec(spec.specId) : null;
  const source = getInsightSourceByJob(job.jobId);

  const counts = { total: spec?.items.length ?? 0, approved: 0, forgone: 0, deferred: 0, pending: 0 };
  const decided = new Map(decisions.map((d) => [d.itemId, d.decision]));
  for (const item of spec?.items ?? []) {
    const decision = decided.get(item.itemId);
    if (decision === 'approve') counts.approved++;
    else if (decision === 'forgo') counts.forgone++;
    else if (decision === 'defer') counts.deferred++;
    else counts.pending++;
  }

  return {
    jobId: job.jobId,
    url: job.url,
    platform: job.platform,
    title: job.title ?? `${PLATFORM_LABELS[job.platform]} post`,
    state: job.state,
    statusMessage: job.statusMessage,
    specId: spec?.specId ?? null,
    runId: run?.runId ?? null,
    itemCounts: counts,
    folderPath: job.folderName ?? null,
    lowConfidence: source?.lowConfidence ?? false,
    cost: job.cost,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function libraryFor(userId: string, limit = 200): LibraryEntry[] {
  return listJobs(userId, limit).map(libraryEntryFor);
}

/** Rewrites the user's `_index.md` from current state (BR-F4, spec §11.2). */
export async function rebuildIndex(userId: string): Promise<void> {
  const entries: IndexEntry[] = libraryFor(userId).map((entry) => ({
    folderName: entry.folderPath ?? '',
    date: entry.createdAt.slice(0, 10),
    platform: PLATFORM_LABELS[entry.platform],
    title: entry.title,
    status: STATE_LABELS[entry.state],
    url: entry.url,
    itemSummary:
      entry.itemCounts.total === 0
        ? '—'
        : `${entry.itemCounts.approved}/${entry.itemCounts.total} approved` +
          (entry.itemCounts.deferred ? `, ${entry.itemCounts.deferred} deferred` : ''),
  }));

  await writeIndex(
    userId,
    entries.filter((entry) => entry.folderName),
  );
}

export { STATE_LABELS };
