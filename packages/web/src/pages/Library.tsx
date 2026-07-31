import { useState } from 'react';
import { PLATFORM_LABELS } from '@aiapp/shared';
import type { LibraryEntry } from '@aiapp/shared';
import { api } from '../api';
import { Badge, Empty, Notice, Segmented, Spinner, StateBadge, relativeTime } from '../components/ui';
import { IconDownload, IconLink, IconRefresh } from '../components/icons';
import { useAsync } from '../hooks';

type Filter = 'all' | 'review' | 'done' | 'attention';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'review', label: 'To review' },
  { id: 'attention', label: 'Needs you' },
  { id: 'done', label: 'Done' },
  { id: 'all', label: 'All' },
];

const PROCESSING_STATES = ['RECEIVED', 'RESOLVED', 'FETCHED', 'TRANSCRIBED', 'NORMALIZED', 'ANALYZED'];

/** The inbox: every captured link and where it got to (BR-F4). */
export function Library({ onOpen }: { onOpen: (entry: LibraryEntry) => void }): JSX.Element {
  const [filter, setFilter] = useState<Filter>('review');

  const { data, loading, error, reload } = useAsync(
    () => api.library(200),
    [],
    {
      // Poll while anything is still moving so the list updates itself.
      intervalMs: 5000,
      stopWhen: (result) =>
        !result.entries.some((entry) => [...PROCESSING_STATES, 'IMPLEMENTING'].includes(entry.state)),
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
      {/* The top bar already says "Inbox" — a second heading here just pushed
          the list further down the screen. */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Segmented
            label="Filter links"
            value={filter}
            onChange={setFilter}
            options={FILTERS.map((option) => ({
              ...option,
              count: option.id === 'review' ? counts.review : option.id === 'attention' ? counts.attention : undefined,
            }))}
          />
        </div>
        <button className="btn btn--ghost btn--icon" onClick={reload} aria-label="Refresh">
          <IconRefresh size={18} />
        </button>
      </div>

      {error ? <Notice kind="danger">{error}</Notice> : null}
      {loading && entries.length === 0 ? (
        <p className="muted">
          <Spinner label="Loading" /> Loading your links…
        </p>
      ) : null}

      {!loading && filtered.length === 0 ? (
        <Empty icon={<IconLink size={26} />} title={emptyTitle(filter)}>
          {filter === 'all'
            ? 'Share a post to this app from your phone, or paste a link on the Capture tab.'
            : 'Nothing in this view right now.'}
        </Empty>
      ) : null}

      <div>
        {filtered.map((entry) => (
          <LibraryRow key={entry.jobId} entry={entry} onOpen={() => onOpen(entry)} />
        ))}
      </div>

      {entries.length > 0 ? (
        <div className="btn-row" style={{ marginTop: 20 }}>
          <a className="btn btn--secondary btn--sm" href={api.exportAllUrl()} download>
            <IconDownload size={15} />
            Download the whole folder
          </a>
        </div>
      ) : null}
    </>
  );
}

function LibraryRow({ entry, onOpen }: { entry: LibraryEntry; onOpen: () => void }): JSX.Element {
  const pending = entry.itemCounts.pending;
  const processing = PROCESSING_STATES.includes(entry.state);

  return (
    <button type="button" className="card card--interactive" onClick={onOpen}>
      <div className="card__row">
        <div style={{ minWidth: 0, flex: 1 }}>
          <p className="card__title">{entry.title}</p>
          <p className="faint" style={{ margin: 0 }}>
            {PLATFORM_LABELS[entry.platform]} · {relativeTime(entry.createdAt)}
          </p>
        </div>
        <StateBadge state={entry.state} />
      </div>

      {entry.statusMessage && processing ? (
        <p className="faint" style={{ margin: '8px 0 0' }}>
          {entry.statusMessage}
        </p>
      ) : null}

      {/* Only what changes the decision to open this row. Per-link processing
          cost lives on the Digest and Settings screens — it is a metric about
          the app, not about the link. */}
      {pending > 0 || entry.itemCounts.approved > 0 || entry.itemCounts.deferred > 0 || entry.lowConfidence ? (
        <div className="badge-row">
          {pending > 0 ? <Badge tone="accent">{pending} to decide</Badge> : null}
          {entry.itemCounts.approved > 0 ? <Badge tone="success">{entry.itemCounts.approved} approved</Badge> : null}
          {entry.itemCounts.deferred > 0 ? <Badge tone="warning">{entry.itemCounts.deferred} deferred</Badge> : null}
          {entry.lowConfidence ? <Badge tone="warning">low confidence</Badge> : null}
        </div>
      ) : null}
    </button>
  );
}

function matchesFilter(entry: LibraryEntry, filter: Filter): boolean {
  switch (filter) {
    case 'review':
      return entry.state === 'SPEC_READY' || entry.state === 'AWAITING_DECISION' || entry.itemCounts.pending > 0;
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
