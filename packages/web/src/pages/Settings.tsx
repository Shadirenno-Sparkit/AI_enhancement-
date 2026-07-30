import { useState } from 'react';
import type { RiskTier, TrustPosture, User } from '@aiapp/shared';
import { api, type Capabilities } from '../api';
import { Badge, Disclosure, Notice, Spinner, relativeTime } from '../components/ui';
import { useAsync } from '../hooks';
import { subscribeToPush } from '../shareQueue';

const POSTURES: { id: TrustPosture; title: string; description: string; tiers: RiskTier[] }[] = [
  {
    id: 'cautious',
    title: 'Ask me every time',
    description: 'Approval alone never runs anything — every item waits for a second confirmation.',
    tiers: [],
  },
  {
    id: 'balanced',
    title: 'Just do the safe ones',
    description:
      'Skills, instructions and generated files run as soon as you approve them. Schedules, downloads and connectors ask again.',
    tiers: ['safe'],
  },
  {
    id: 'just_do_it',
    title: 'Just do it',
    description: 'Everything you approve runs immediately, including connectors and downloads.',
    tiers: ['safe', 'moderate', 'sensitive'],
  },
];

const CONNECTOR_KINDS = [
  { kind: 'gmail', label: 'Email (Gmail)' },
  { kind: 'calendar', label: 'Calendar' },
  { kind: 'slack', label: 'Slack' },
  { kind: 'github', label: 'GitHub' },
  { kind: 'notion', label: 'Notion' },
  { kind: 'filesystem', label: 'Files' },
];

export function Settings({
  user,
  capabilities,
  onUserChanged,
  onSignOut,
  toast,
}: {
  user: User;
  capabilities: Capabilities | null;
  onUserChanged: (user: User) => void;
  onSignOut: () => void;
  toast: (message: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const usage = useAsync(() => api.usage(), []);
  const connectors = useAsync(() => api.connectors(), []);
  const schedules = useAsync(() => api.schedules(), []);

  const update = async (patch: Parameters<typeof api.preferences>[0]): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.preferences(patch);
      onUserChanged(result.user);
      toast('Saved');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Settings</h1>
      <p className="lede">Signed in as {user.email}</p>

      <h2>How much should it just do?</h2>
      <p className="muted" style={{ fontSize: 14.5 }}>
        You always approve each item first. This controls what happens <em>after</em> you approve.
      </p>
      {POSTURES.map((posture) => (
        <label
          key={posture.id}
          className="card card--flat"
          style={{
            display: 'flex',
            gap: 12,
            cursor: 'pointer',
            borderColor: user.preferences.trustPosture === posture.id ? 'var(--accent)' : undefined,
          }}
        >
          <input
            type="radio"
            name="posture"
            checked={user.preferences.trustPosture === posture.id}
            onChange={() => void update({ trustPosture: posture.id, autoImplementTiers: null })}
            style={{ width: 22, height: 22, marginTop: 2, accentColor: 'var(--accent)' }}
          />
          <div>
            <strong>{posture.title}</strong>
            <p className="muted" style={{ margin: '2px 0 0', fontSize: 14 }}>
              {posture.description}
            </p>
          </div>
        </label>
      ))}

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={user.preferences.dryRunFirst}
          onChange={(e) => void update({ dryRunFirst: e.target.checked })}
        />
        <span>
          <strong>Always preview first</strong>
          <br />
          <span className="muted" style={{ fontSize: 14 }}>
            Approving shows what would change instead of changing it. You then confirm to run for real.
          </span>
        </span>
      </label>

      <h2>Notifications</h2>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={user.preferences.weeklyDigest}
          onChange={(e) => void update({ weeklyDigest: e.target.checked })}
        />
        <span>
          <strong>Weekly digest</strong>
          <br />
          <span className="muted" style={{ fontSize: 14 }}>
            A Friday summary of what you captured, implemented, deferred and skipped.
          </span>
        </span>
      </label>

      <div className="card card--flat">
        <div className="split">
          <div>
            <strong>Quiet hours</strong>
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              Notifications inside this window are held until it ends.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              className="input"
              type="number"
              min={0}
              max={23}
              style={{ width: 68 }}
              aria-label="Quiet hours start"
              value={user.preferences.quietHours?.start ?? 22}
              onChange={(e) =>
                void update({
                  quietHours: { start: Number(e.target.value), end: user.preferences.quietHours?.end ?? 7 },
                })
              }
            />
            <span className="faint">to</span>
            <input
              className="input"
              type="number"
              min={0}
              max={23}
              style={{ width: 68 }}
              aria-label="Quiet hours end"
              value={user.preferences.quietHours?.end ?? 7}
              onChange={(e) =>
                void update({
                  quietHours: { start: user.preferences.quietHours?.start ?? 22, end: Number(e.target.value) },
                })
              }
            />
          </div>
        </div>
      </div>

      {capabilities?.pushPublicKey ? (
        <button
          className="btn btn--secondary btn--block"
          onClick={async () => {
            const subscription = await subscribeToPush(capabilities.pushPublicKey!);
            if (subscription) {
              await api.savePushSubscription(subscription);
              toast('Push notifications enabled');
            } else {
              toast('Notification permission was not granted');
            }
          }}
        >
          Enable push notifications
        </button>
      ) : null}

      <h2>Connectors</h2>
      <p className="muted" style={{ fontSize: 14.5 }}>
        Items that depend on a tool you have not connected are flagged rather than silently skipped. Marking a
        connector as available here clears that flag.
      </p>
      {connectors.data?.connectors.map((connector) => (
        <div key={connector.connectorId} className="card card--flat split">
          <div>
            <strong>{connector.label}</strong>{' '}
            <Badge tone={connector.configured ? 'success' : 'warning'}>
              {connector.configured ? 'connected' : 'not configured'}
            </Badge>
          </div>
          <button
            className="btn btn--ghost btn--sm"
            onClick={async () => {
              await api.deleteConnector(connector.kind);
              connectors.reload();
              toast('Removed');
            }}
          >
            Remove
          </button>
        </div>
      ))}

      <Disclosure summary="Add a connector">
        <div className="stack">
          {CONNECTOR_KINDS.filter(
            (candidate) => !connectors.data?.connectors.some((existing) => existing.kind === candidate.kind),
          ).map((candidate) => (
            <button
              key={candidate.kind}
              className="btn btn--secondary btn--block"
              onClick={async () => {
                // Marks the connector present. Real OAuth flows plug in here;
                // the secret is stored encrypted and never returned to the client.
                await api.saveConnector(candidate.kind, { label: candidate.label, secret: 'configured' });
                connectors.reload();
                toast(`${candidate.label} marked as connected`);
              }}
            >
              + {candidate.label}
            </button>
          ))}
        </div>
      </Disclosure>

      {schedules.data && schedules.data.tasks.length > 0 ? (
        <>
          <h2>Scheduled routines</h2>
          {schedules.data.tasks.map((task) => (
            <div key={task.taskId} className="card card--flat">
              <div className="split">
                <div style={{ minWidth: 0 }}>
                  <strong>{task.name}</strong>
                  <p className="faint" style={{ margin: 0 }}>
                    {task.humanReadable}
                    {task.nextRunAt ? ` · next ${relativeTime(task.nextRunAt)}` : ''}
                  </p>
                </div>
                <div className="btn-row">
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={async () => {
                      await api.setSchedule(task.taskId, !task.enabled);
                      schedules.reload();
                    }}
                  >
                    {task.enabled ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={async () => {
                      await api.deleteSchedule(task.taskId);
                      schedules.reload();
                      toast('Removed');
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </>
      ) : null}

      <h2>Usage & budget</h2>
      {usage.data ? (
        <div className="grid-2">
          <div className="stat">
            <div className="stat__value">${usage.data.today.usd.toFixed(3)}</div>
            <div className="stat__label">spent today of ${usage.data.limits.maxUsdPerUserPerDay.toFixed(2)}</div>
          </div>
          <div className="stat">
            <div className="stat__value">{usage.data.total.jobs}</div>
            <div className="stat__label">links processed</div>
          </div>
          <div className="stat">
            <div className="stat__value">{Math.round(usage.data.today.asrSeconds)}s</div>
            <div className="stat__label">speech-to-text today</div>
          </div>
          <div className="stat">
            <div className="stat__value">${usage.data.total.usd.toFixed(3)}</div>
            <div className="stat__label">total spend</div>
          </div>
        </div>
      ) : (
        <p className="muted">
          <Spinner label="Loading" /> Loading usage…
        </p>
      )}

      <h2>This deployment</h2>
      <div className="card card--flat">
        {capabilities ? (
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: 14 }}>
            <dt className="faint">Analysis</dt>
            <dd style={{ margin: 0 }}>
              {capabilities.analysis.provider}{' '}
              <Badge tone={capabilities.analysis.live ? 'success' : 'warning'}>
                {capabilities.analysis.live ? 'live' : 'offline analyzer'}
              </Badge>
            </dd>
            <dt className="faint">Speech-to-text</dt>
            <dd style={{ margin: 0 }}>
              {capabilities.speechToText.provider}{' '}
              <Badge tone={capabilities.speechToText.live ? 'success' : 'warning'}>
                {capabilities.speechToText.live ? 'live' : 'disabled'}
              </Badge>
            </dd>
            <dt className="faint">Vision / OCR</dt>
            <dd style={{ margin: 0 }}>
              {capabilities.vision.provider}{' '}
              <Badge tone={capabilities.vision.live ? 'success' : 'warning'}>
                {capabilities.vision.live ? 'live' : 'disabled'}
              </Badge>
            </dd>
            <dt className="faint">Browser agent</dt>
            <dd style={{ margin: 0 }}>
              <Badge tone={capabilities.browserAgent ? 'success' : 'default'}>
                {capabilities.browserAgent ? 'enabled' : 'off'}
              </Badge>
            </dd>
          </dl>
        ) : null}
      </div>

      <h2>Your data</h2>
      <div className="btn-row">
        <a className="btn btn--secondary" href={api.exportAllUrl()} download>
          ⬇ Export everything
        </a>
        <button className="btn btn--secondary" onClick={onSignOut} disabled={busy}>
          Sign out
        </button>
      </div>

      <Disclosure summary="Delete my data">
        <p className="muted" style={{ fontSize: 14 }}>
          Removes every link, transcript, spec, decision, run and artifact belonging to you. The audit log is kept
          but de-identified. This cannot be undone.
        </p>
        <button
          className="btn btn--danger btn--block"
          onClick={async () => {
            if (!window.confirm('Delete all your links, specs and artifacts? This cannot be undone.')) return;
            await api.deleteAllData(true);
            toast('Your data has been deleted');
            window.location.hash = '/library';
          }}
        >
          Delete all my data
        </button>
      </Disclosure>

      {!capabilities?.analysis.live ? (
        <Notice kind="info">
          Running without a model key. Links are still captured, extracted and specced by the built-in rule-based
          analyzer — add <code>ANTHROPIC_API_KEY</code> to <code>.env</code> and restart for full-quality analysis.
        </Notice>
      ) : null}
    </>
  );
}
