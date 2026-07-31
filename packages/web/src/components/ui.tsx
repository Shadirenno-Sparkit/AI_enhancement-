import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { renderMarkdown, type JobState } from '@aiapp/shared';
import { IconAlert, IconCheck, IconClose, IconSparkle } from './icons';

export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <span>
      <span className="spinner" aria-hidden="true" />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

const NOTICE_ICONS = {
  info: IconSparkle,
  warning: IconAlert,
  danger: IconAlert,
  success: IconCheck,
} as const;

export function Notice({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'warning' | 'danger' | 'success';
  children: ReactNode;
}): JSX.Element {
  const Icon = NOTICE_ICONS[kind];
  return (
    <div className={`notice notice--${kind}`} role={kind === 'danger' ? 'alert' : 'status'}>
      <span className="notice__icon">
        <Icon size={17} />
      </span>
      <div className="notice__body">{children}</div>
    </div>
  );
}

export function Badge({
  tone = 'default',
  children,
}: {
  tone?: 'default' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'chip';
  children: ReactNode;
}): JSX.Element {
  return <span className={tone === 'default' ? 'badge' : `badge badge--${tone}`}>{children}</span>;
}

export function Empty({
  icon,
  title,
  children,
}: {
  /** Rendered inside a neutral tile so empty states read as designed, not as a stray glyph. */
  icon: ReactNode;
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

/**
 * One control, N mutually exclusive states.
 *
 * `role` matters: filters are `tablist`/`tab` (they change what is shown),
 * while a decision is `radiogroup`/`radio` (it records a choice). The visual
 * treatment is shared; the semantics are not.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  as = 'tabs',
  className,
}: {
  value: T | null;
  options: { id: T; label: string; count?: number; icon?: ReactNode }[];
  onChange: (id: T) => void;
  label: string;
  as?: 'tabs' | 'radio';
  className?: string;
}): JSX.Element {
  const isTabs = as === 'tabs';
  return (
    <div
      className={className ? `segmented ${className}` : 'segmented'}
      role={isTabs ? 'tablist' : 'radiogroup'}
      aria-label={label}
    >
      {options.map((option) => {
        const selected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            className="segmented__option"
            data-choice={option.id}
            role={isTabs ? 'tab' : 'radio'}
            {...(isTabs ? { 'aria-selected': selected } : { 'aria-checked': selected })}
            onClick={() => onChange(option.id)}
          >
            {option.icon}
            {option.label}
            {option.count ? <span className="segmented__count">{option.count}</span> : null}
          </button>
        );
      })}
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

/**
 * Puts the app into "commit mode" while a sticky action bar is on screen: the
 * tab bar stands down and the main content pads to clear the taller bar, so the
 * card the user just decided on is never hidden underneath the approve button.
 */
export function useCommitMode(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    document.body.classList.add('has-actionbar');
    return () => document.body.classList.remove('has-actionbar');
  }, [active]);
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
        <svg
          className="disclosure__caret"
          width={12}
          height={12}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        {summary}
      </button>
      {open ? <div className="item__details">{children}</div> : null}
    </>
  );
}

export { IconCheck, IconClose };

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
