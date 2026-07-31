import { useState } from 'react';
import { api } from '../api';
import { Badge, Disclosure, Empty, Notice, Spinner, relativeTime } from '../components/ui';
import { IconCalendar, IconChart } from '../components/icons';
import { useAsync } from '../hooks';

/**
 * The weekly digest (BRD §10) — the learning journal of your AI setup, and the
 * screen where the product's headline KPI lives: how much of what you saved
 * actually got adopted.
 */
export function Digest({ onOpen }: { onOpen: (jobId: string) => void }): JSX.Element {
  const [days, setDays] = useState(7);
  const { data, loading, error } = useAsync(() => api.digest(days), [days]);

  if (error) return <Notice kind="danger">{error}</Notice>;
  if (loading && !data) {
    return (
      <p className="muted">
        <Spinner label="Loading" /> Building your digest…
      </p>
    );
  }
  if (!data) return <Empty icon={<IconChart size={26} />} title="No digest yet" />;

  const adoption = Math.round(data.captureToActionRate * 100);

  return (
    <>
      <div style={{ marginBottom: 14 }}>
        <select
          className="select"
          style={{ width: 'auto', minHeight: 38 }}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          aria-label="Digest period"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      {/* One number is the point of this screen: of everything you saved, how
          much actually got adopted. The rest are supporting counts. */}
      <div className="grid-2" style={{ marginBottom: 18 }}>
        <div className="stat stat--hero">
          <div className="stat__value">{adoption}%</div>
          <div className="stat__label">
            of what you captured turned into a change — {data.implemented.length} improvement
            {data.implemented.length === 1 ? '' : 's'} from {data.totals.captured} link
            {data.totals.captured === 1 ? '' : 's'}
          </div>
        </div>
        <div className="stat">
          <div className="stat__value">{data.totals.captured}</div>
          <div className="stat__label">links captured</div>
        </div>
        <div className="stat">
          <div className="stat__value">{data.implemented.length}</div>
          <div className="stat__label">improvements implemented</div>
        </div>
      </div>

      {data.totals.captured === 0 ? (
        <Empty icon={<IconCalendar size={26} />} title="Nothing captured in this window">
          Share a post to this app and it will show up here.
        </Empty>
      ) : null}

      {data.awaitingReview.length > 0 ? (
        <>
          <h2>Waiting on you</h2>
          {data.awaitingReview.map((entry) => (
            <button key={entry.jobId} className="card card--interactive" onClick={() => onOpen(entry.jobId)}>
              <div className="split">
                <strong style={{ fontSize: 15 }}>{entry.title}</strong>
                <Badge tone="accent">{entry.items} to decide</Badge>
              </div>
            </button>
          ))}
        </>
      ) : null}

      {data.implemented.length > 0 ? (
        <>
          <h2>What changed</h2>
          <div className="card">
            {data.implemented.map((entry, index) => (
              <div
                key={`${entry.runId}-${index}`}
                style={{ padding: '10px 0', borderTop: index === 0 ? 'none' : '1px solid var(--border)' }}
              >
                <strong style={{ fontSize: 14.5 }}>{entry.title}</strong>
                <p className="muted" style={{ margin: '2px 0 0', fontSize: 14 }}>
                  {entry.summary}
                </p>
                <p className="faint" style={{ margin: '2px 0 0' }}>
                  {relativeTime(entry.at)}
                </p>
              </div>
            ))}
          </div>
        </>
      ) : null}

      {data.needsYou.length > 0 ? (
        <>
          <h2>Needs a hand</h2>
          <div className="card">
            {data.needsYou.map((entry, index) => (
              <div key={index} style={{ padding: '8px 0' }}>
                <strong style={{ fontSize: 14.5 }}>{entry.title}</strong>
                {entry.needsInput ? (
                  <p className="muted" style={{ margin: '2px 0 0', fontSize: 14 }}>
                    {entry.needsInput}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : null}

      {data.lowConfidence.length > 0 ? (
        <Notice kind="warning">
          {data.lowConfidence.length} link{data.lowConfidence.length === 1 ? '' : 's'} had a low-confidence
          extraction. Open one and use &ldquo;Re-run stronger&rdquo; if the spec looks thin.
        </Notice>
      ) : null}

      {/* Reference material: interesting, but not what the screen is for. */}
      {Object.keys(data.byPlatform).length > 0 || Object.keys(data.preferenceProfile).length > 0 ? (
        <>
          <p className="section-label">Patterns</p>
          <div className="card" style={{ padding: 0 }}>
            {Object.keys(data.byPlatform).length > 0 ? (
              <Disclosure summary="Where your links come from">
                <div className="badge-row" style={{ marginTop: 0 }}>
                  {Object.entries(data.byPlatform)
                    .sort((a, b) => b[1] - a[1])
                    .map(([platform, count]) => (
                      <Badge key={platform} tone="chip">
                        {platform} · {count}
                      </Badge>
                    ))}
                </div>
              </Disclosure>
            ) : null}

            {Object.keys(data.preferenceProfile).length > 0 ? (
              <Disclosure summary="What you tend to approve">
                <p className="faint" style={{ marginTop: 0 }}>
                  Learned from your decisions — used to rank future suggestions.
                </p>
                {Object.entries(data.preferenceProfile).map(([type, stats]) => (
                  <div key={type} className="split" style={{ padding: '5px 0', fontSize: 14 }}>
                    <code>{type}</code>
                    <span className="muted tabular">
                      {stats.approve} approved · {stats.forgo} skipped
                    </span>
                  </div>
                ))}
              </Disclosure>
            ) : null}

            <Disclosure summary="Processing cost">
              <div className="split" style={{ fontSize: 14 }}>
                <span className="muted">Spent in this window</span>
                <strong className="tabular">${data.totals.usd.toFixed(2)}</strong>
              </div>
            </Disclosure>
          </div>
        </>
      ) : null}
    </>
  );
}
