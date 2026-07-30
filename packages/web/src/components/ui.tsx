import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { renderMarkdown, type JobState } from '@aiapp/shared';

export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <span>
      <span className="spinner" aria-hidden="true" />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

export function Notice({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'warning' | 'danger' | 'success';
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={`notice notice--${kind}`} role={kind === 'danger' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Badge({
  tone = 'default',
  children,
}: {
  tone?: 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'info';
  children: ReactNode;
}): JSX.Element {
  return <span className={tone === 'default' ? 'badge' : `badge badge--${tone}`}>{children}</span>;
}

export function Empty({
  icon,
  title,
  children,
}: {
  icon: string;
  title: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="empty">
      <div className="empty__icon" aria-hidden="true">
        {icon}
      </div>
      <h2 style={{ margin: '0 0 6px', fontSize: 17 }}>{title}</h2>
      {children ? <p className="muted" style={{ maxWidth: 380, margin: '0 auto' }}>{children}</p> : null}
    </div>
  );
}

/** Transient confirmation; auto-dismisses so it never blocks the next action. */
export function Toast({ message, onDone }: { message: string | null; onDone: () => void }): JSX.Element | null {
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(onDone, 3200);
    return () => window.clearTimeout(timer);
  }, [message, onDone]);

  if (!message) return null;
  return (
    <div className="toast" role="status" aria-live="polite">
      {message}
    </div>
  );
}

/** Plain-language status label. Users never see the raw state machine. */
const STATE_LABELS: Record<JobState, { text: string; tone: 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'info' }> = {
  RECEIVED: { text: 'Queued', tone: 'default' },
  RESOLVED: { text: 'Reading', tone: 'info' },
  FETCHED: { text: 'Reading', tone: 'info' },
  TRANSCRIBED: { text: 'Transcribing', tone: 'info' },
  NORMALIZED: { text: 'Analysing', tone: 'info' },
  ANALYZED: { text: 'Analysing', tone: 'info' },
  SPEC_READY: { text: 'Ready to review', tone: 'accent' },
  AWAITING_DECISION: { text: 'Ready to review', tone: 'accent' },
  IMPLEMENTING: { text: 'Implementing', tone: 'info' },
  DONE: { text: 'Implemented', tone: 'success' },
  PARTIAL: { text: 'Partly done', tone: 'warning' },
  NEEDS_INPUT: { text: 'Needs you', tone: 'warning' },
  NO_ACTION: { text: 'No action', tone: 'default' },
  FAILED: { text: 'Failed', tone: 'danger' },
};

export function StateBadge({ state }: { state: JobState }): JSX.Element {
  const label = STATE_LABELS[state];
  return <Badge tone={label.tone}>{label.text}</Badge>;
}

export function Progress({ value, label }: { value: number; label?: string }): JSX.Element {
  return (
    <div
      className="progress"
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? 'Processing progress'}
    >
      <div className="progress__bar" style={{ width: `${Math.max(3, Math.min(100, value))}%` }} />
    </div>
  );
}

/** Collapsible section; closed by default to keep the review screen scannable. */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: string;
  children: ReactNode;
  defaultOpen?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <button type="button" className="disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {summary}
      </button>
      {open ? <div className="item__details">{children}</div> : null}
    </>
  );
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Renders the subset of Markdown the server emits. The renderer lives in
 * `@aiapp/shared` because its escaping guarantee is covered by the server test
 * suite — spec text is model-authored, so it must never become live markup.
 */
export function Markdown({ source }: { source: string }): JSX.Element {
  return <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }} />;
}
