import { useState } from 'react';
import { INPUT_KIND_LABELS, LIFE_DOMAIN_LABELS, PLATFORM_LABELS } from '@aiapp/shared';
import type { LibraryEntry } from '@aiapp/shared';
import { api } from '../api';
import { Badge, Empty, Notice, Spinner, StateBadge, relativeTime } from '../components/ui';
import { useAsync } from '../hooks';

type Filter = 'all' | 'review' | 'done' | 'attention';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'review', label: 'To review' },
  { id: 'attention', label: 'Needs you' },
  { id: 'done', label: 'Done' },
  { id: 'all', label: 'All' },
];

/** The inbox: every captured link and where it got to (BR-F4). */
export function Library({
  onOpen,
  toast,
}: {
  onOpen: (entry: LibraryEntry) => void;
  toast: (message: string) => void;
}): JSX.Element {
  const [filter, setFilter] = useState<Filter>('review');

  const { data, loading, error, reload } = useAsync(
    () => api.library(200),
    [],
    {
      // Poll while anything is still moving so the list updates itself.
      intervalMs: 5000,
      stopWhen: (result) =>
        !result.entries.some((entry) =>
          ['RECEIVED', 'RESOLVED', 'FETCHED', 'TRANSCRIBED', 'NORMALIZED', 'ANALYZED', 'IMPLEMENTING'].includes(
            entry.state,
          ),
        ),
    },
  );

  const entries = data?.entries ?? [];
  const filtered = entries.filter((entry) => matchesFilter(entry, filter));
  const counts = {
    review: entries.filter((entry) => matchesFilter(entry, 'review')).length,
    attention: entries.filter((entry) => matchesFilter(entry, 'attention')).length,
  };

  return (
    <>
      <div className="split">
        <h1>Your links</h1>
        <button className="btn btn--ghost btn--sm" onClick={reload} aria-label="Refresh">
          ↻
        </button>
      </div>

      <div className="btn-row" style={{ marginBottom: 16 }} role="tablist" aria-label="Filter links">
        {FILTERS.map((option) => (
          <button
            key={option.id}
            role="tab"
            aria-selected={filter === option.id}
            className={filter === option.id ? 'btn btn--sm' : 'btn btn--secondary btn--sm'}
            onClick={() => setFilter(option.id)}
          >
            {option.label}
            {option.id === 'review' && counts.review > 0 ? ` (${counts.review})` : ''}
            {option.id === 'attention' && counts.attention > 0 ? ` (${counts.attention})` : ''}
          </button>
        ))}
      </div>

      {error ? <Notice kind="danger">{error}</Notice> : null}
      {loading && entries.length === 0 ? (
        <p className="muted">
          <Spinner label="Loading" /> Loading your links…
        </p>
      ) : null}

      {!loading && filtered.length === 0 ? (
        <Empty icon="🔗" title={emptyTitle(filter)}>
          {filter === 'all'
            ? 'Share a post to this app from your phone, or paste a link on the Capture tab.'
            : 'Nothing in this view right now.'}
        </Empty>
      ) : null}

      <div>
        {filtered.map((entry) => (
          <LibraryRow
            key={entry.jobId}
            entry={entry}
            onOpen={() => onOpen(entry)}
            onPlanned={reload}
            toast={toast}
          />
        ))}
      </div>

      {entries.length > 0 ? (
        <div className="btn-row" style={{ marginTop: 20 }}>
          <a className="btn btn--secondary btn--sm" href={api.exportAllUrl()} download>
            ⬇ Download the whole folder
          </a>
        </div>
      ) : null}
    </>
  );
}

function LibraryRow({
  entry,
  onOpen,
  onPlanned,
  toast,
}: {
  entry: LibraryEntry;
  onOpen: () => void;
  onPlanned: () => void;
  toast: (message: string) => void;
}): JSX.Element {
  const pending = entry.itemCounts.pending;
  const processing = ['RECEIVED', 'RESOLVED', 'FETCHED', 'TRANSCRIBED', 'NORMALIZED', 'TRIAGED', 'ANALYZED'].includes(
    entry.state,
  );
  const [planning, setPlanning] = useState(false);

  // Triage parked this: worth something, but not enough to plan unprompted.
  // The headline is already on the row, so the user decides with the same
  // information the gate used.
  const awaitingPlan = entry.state === 'AWAITING_PLAN';

  const source =
    entry.inputKind === 'link' ? PLATFORM_LABELS[entry.platform] : INPUT_KIND_LABELS[entry.inputKind];

  return (
    <div className={`card card--interactive${awaitingPlan ? ' card--awaiting' : ''}`}>
      <button
        type="button"
        onClick={onOpen}
        style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}
      >
        <div className="card__row">
          <div style={{ minWidth: 0, flex: 1 }}>
            <p className="card__title">{entry.title}</p>
            <p className="faint" style={{ margin: 0 }}>
              {source} · {relativeTime(entry.createdAt)}
            </p>
          </div>
          <StateBadge state={entry.state} />
        </div>

        {entry.statusMessage && (processing || awaitingPlan) ? (
          <p className="faint" style={{ margin: '8px 0 0' }}>
            {entry.statusMessage}
          </p>
        ) : null}

        <div className="badge-row">
          {entry.domains.map((domain) => (
            <Badge key={domain}>{LIFE_DOMAIN_LABELS[domain]}</Badge>
          ))}
          {pending > 0 ? <Badge tone="accent">{pending} to decide</Badge> : null}
          {entry.itemCounts.approved > 0 ? <Badge tone="success">{entry.itemCounts.approved} approved</Badge> : null}
          {entry.itemCounts.deferred > 0 ? <Badge tone="warning">{entry.itemCounts.deferred} deferred</Badge> : null}
          {entry.lowConfidence ? <Badge tone="warning">low confidence</Badge> : null}
          {entry.cost.usd > 0 ? <Badge>${entry.cost.usd.toFixed(3)}</Badge> : null}
        </div>
      </button>

      {awaitingPlan ? (
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="btn btn--sm"
            disabled={planning}
            onClick={async () => {
              setPlanning(true);
              try {
                const result = await api.planNow(entry.jobId);
                toast(result.alreadyPlanned ? 'Already planned — opening it' : 'Working out what you should do…');
                onPlanned();
              } catch (err) {
                toast(err instanceof Error ? err.message : 'Could not plan that.');
              } finally {
                setPlanning(false);
              }
            }}
          >
            {planning ? 'Planning…' : 'Plan this'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function matchesFilter(entry: LibraryEntry, filter: Filter): boolean {
  switch (filter) {
    case 'review':
      return (
        entry.state === 'SPEC_READY' ||
        entry.state === 'AWAITING_DECISION' ||
        entry.state === 'AWAITING_PLAN' ||
        entry.itemCounts.pending > 0
      );
    case 'attention':
      return entry.state === 'NEEDS_INPUT' || entry.state === 'FAILED' || entry.lowConfidence;
    case 'done':
      return entry.state === 'DONE' || entry.state === 'PARTIAL';
    case 'all':
    default:
      return true;
  }
}

function emptyTitle(filter: Filter): string {
  switch (filter) {
    case 'review':
      return 'Nothing waiting on you';
    case 'attention':
      return 'Nothing needs your attention';
    case 'done':
      return 'Nothing implemented yet';
    default:
      return 'No links captured yet';
  }
}
