import { useEffect, useMemo, useState } from 'react';
import type { DecisionChoice, ItemResult, ItemType, Provenance } from '@aiapp/shared';
import { PLATFORM_LABELS } from '@aiapp/shared';
import { api, type ReviewItem, type SpecView } from '../api';
import {
  Badge,
  Disclosure,
  Markdown,
  Notice,
  Progress,
  Segmented,
  Spinner,
  relativeTime,
  useCommitMode,
} from '../components/ui';
import { IconAlert, IconDownload, IconExternal, IconFile } from '../components/icons';
import { useAsync } from '../hooks';

const TYPE_LABELS: Record<ItemType, string> = {
  create_skill: 'Reusable skill',
  set_instruction: 'Standing instruction',
  schedule_task: 'Scheduled routine',
  connect_tool: 'Connect a tool',
  download_file: 'Download',
  generate_file: 'Generated file',
  configure_setting: 'Setting change',
  run_command: 'Command',
};

const PROVENANCE_LABELS: Record<Provenance, string> = {
  post_description: 'post caption',
  author_caption: 'author captions',
  auto_caption: 'auto captions',
  asr_whisper: 'speech-to-text',
  asr_hosted: 'speech-to-text',
  ocr_multimodal: 'on-screen text',
  ocr_tesseract: 'on-screen text (OCR)',
  browser_dom: 'page text',
  user_note: 'your note',
};

const PROCESSING_STATES = ['RECEIVED', 'RESOLVED', 'FETCHED', 'TRANSCRIBED', 'NORMALIZED', 'ANALYZED'];

/** The three outcomes an item can have, in escalating order of commitment. */
const DECISION_OPTIONS: { id: DecisionChoice; label: string }[] = [
  { id: 'forgo', label: 'Skip' },
  { id: 'defer', label: 'Later' },
  { id: 'approve', label: 'Approve' },
];

/**
 * The review screen (spec §4.5).
 *
 * While the pipeline runs it shows honest progress; once a spec exists it
 * becomes the approve/forgo gate. Decisions default to unselected — nothing is
 * opt-out (BR-R2).
 */
export function Review({ jobId, toast }: { jobId: string; toast: (message: string) => void }): JSX.Element {
  const status = useAsync(() => api.jobStatus(jobId), [jobId], {
    intervalMs: 3000,
    stopWhen: (data) => !PROCESSING_STATES.includes(data.job.state),
  });

  const specId = status.data?.specId ?? null;

  const spec = useAsync(() => api.spec(specId!), [specId], {
    enabled: Boolean(specId),
    intervalMs: 4000,
    // Keep polling while a run is in flight so results stream in.
    stopWhen: (data) => !data.run || ['done', 'partial', 'needs_input', 'failed'].includes(data.run.status),
  });

  if (status.error) return <Notice kind="danger">{status.error}</Notice>;
  if (!status.data) {
    return (
      <p className="muted">
        <Spinner label="Loading" /> Loading…
      </p>
    );
  }

  const job = status.data.job;
  const processing = PROCESSING_STATES.includes(job.state);

  return (
    <>
      <h1>{job.title ?? `${PLATFORM_LABELS[job.platform]} post`}</h1>
      <p className="faint" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span>
          {PLATFORM_LABELS[job.platform]} · captured {relativeTime(job.createdAt)}
        </span>
        <a
          href={job.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
        >
          open original
          <IconExternal size={12} />
        </a>
      </p>

      {processing ? (
        <div className="card">
          <p style={{ margin: '0 0 4px', fontWeight: 600 }}>
            <Spinner label="Processing" /> {job.statusMessage ?? 'Working on it…'}
          </p>
          <Progress value={status.data.progress} label="Processing this link" />
          <p className="faint" style={{ margin: 0 }}>
            You can leave this screen — you will be notified when the spec is ready.
          </p>
        </div>
      ) : null}

      {job.state === 'FAILED' ? (
        <Notice kind="danger">
          <strong>This link could not be processed.</strong>
          <br />
          {job.statusMessage}
        </Notice>
      ) : null}

      {job.state === 'NO_ACTION' && !specId ? (
        <Notice kind="info">
          <strong>Nothing to act on.</strong>
          <br />
          {job.statusMessage}
        </Notice>
      ) : null}

      {status.data.lowConfidence ? (
        <Notice kind="warning">
          <strong>Low-confidence extraction.</strong> The text behind this spec may be incomplete or misread —
          check it against the original before approving.{' '}
          <button
            className="btn btn--ghost btn--sm"
            onClick={async () => {
              await api.rerun(jobId);
              toast('Re-running with the heavier extraction path');
              status.reload();
            }}
          >
            Re-run stronger
          </button>
        </Notice>
      ) : null}

      {specId && spec.data ? <SpecReview view={spec.data} onChanged={() => spec.reload()} toast={toast} /> : null}
      {specId && !spec.data && spec.loading ? (
        <p className="muted">
          <Spinner label="Loading spec" /> Loading the spec…
        </p>
      ) : null}

      <Artifacts jobId={jobId} />
    </>
  );
}

function SpecReview({
  view,
  onChanged,
  toast,
}: {
  view: SpecView;
  onChanged: () => void;
  toast: (message: string) => void;
}): JSX.Element {
  const { spec, extraction, run } = view;

  // Local selection state, seeded from any decision already recorded.
  const [selection, setSelection] = useState<Record<string, DecisionChoice | null>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelection(Object.fromEntries(spec.items.map((item) => [item.itemId, item.decision])));
  }, [spec.specId, spec.items]);

  const undecided = spec.items.filter((item) => !item.decision);
  const approvedCount = useMemo(
    () => Object.values(selection).filter((choice) => choice === 'approve').length,
    [selection],
  );
  const anyChange = useMemo(
    () => spec.items.some((item) => (selection[item.itemId] ?? null) !== item.decision),
    [selection, spec.items],
  );

  // While there are decisions to submit, the bottom of the screen belongs to
  // the commit bar rather than to navigation.
  useCommitMode(anyChange);

  const setChoice = (itemId: string, choice: DecisionChoice | null): void => {
    setSelection((current) => ({ ...current, [itemId]: choice }));
  };

  const submit = async (dryRun: boolean): Promise<void> => {
    const decisions = spec.items
      .map((item) => ({ itemId: item.itemId, decision: selection[item.itemId] }))
      .filter((entry): entry is { itemId: string; decision: DecisionChoice } => Boolean(entry.decision));

    if (decisions.length === 0) {
      setError('Choose approve or skip on at least one item.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await api.decide(spec.specId, decisions, dryRun);
      toast(
        result.runId
          ? dryRun
            ? 'Previewing what would change…'
            : 'Approved — implementing now'
          : 'Decisions saved',
      );
      if (result.awaitingConfirmation.length > 0) {
        toast(`${result.awaitingConfirmation.length} item(s) need an extra confirmation — see the results below.`);
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const resultsByItem = new Map((run?.items ?? []).map((result) => [result.itemId, result]));

  return (
    <>
      <h2>What this post is telling you to do</h2>
      <div className="card">
        <Markdown source={spec.summaryPlainEnglish} />
        {extraction ? (
          <div className="badge-row">
            <Badge tone={extraction.lowConfidence ? 'warning' : 'success'}>
              {(extraction.overallConfidence * 100).toFixed(0)}% confidence
            </Badge>
            {extraction.methodsUsed.map((method) => (
              <Badge key={method} tone="chip">
                {PROVENANCE_LABELS[method]}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>

      {spec.noActionableItems || spec.items.length === 0 ? (
        <Notice kind="info">
          No actionable items were found in this post — nothing was invented to fill the gap.
        </Notice>
      ) : (
        <>
          <div className="section-head">
            <h2>
              {spec.items.length} proposed improvement{spec.items.length === 1 ? '' : 's'}
            </h2>
            {undecided.length > 0 ? (
              <div className="btn-row">
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() =>
                    setSelection(Object.fromEntries(spec.items.map((item) => [item.itemId, 'approve' as const])))
                  }
                >
                  Approve all
                </button>
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() =>
                    setSelection(Object.fromEntries(spec.items.map((item) => [item.itemId, 'forgo' as const])))
                  }
                >
                  Skip all
                </button>
              </div>
            ) : null}
          </div>

          {spec.items.map((item) => (
            <ItemCard
              key={item.itemId}
              item={item}
              choice={selection[item.itemId] ?? null}
              result={resultsByItem.get(item.itemId)}
              onChoose={(choice) => setChoice(item.itemId, choice)}
              onRevert={async () => {
                await api.revert(spec.specId, item.itemId);
                toast('Reverted');
                onChanged();
              }}
            />
          ))}

          {error ? <Notice kind="danger">{error}</Notice> : null}

          {anyChange ? (
            <div className="actionbar">
              <div className="actionbar__inner">
                <button
                  className="btn btn--secondary"
                  onClick={() => void submit(true)}
                  disabled={submitting || approvedCount === 0}
                  title="See what would change without changing anything"
                >
                  Preview
                </button>
                <button
                  className="btn"
                  style={{ flex: 1 }}
                  onClick={() => void submit(false)}
                  disabled={submitting}
                >
                  {submitting ? <Spinner label="Submitting" /> : null}
                  {approvedCount > 0 ? `Approve ${approvedCount} & implement` : 'Save decisions'}
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}

      {run ? <RunResults run={run} /> : null}

      <p className="section-label">Technical spec</p>
      <div className="card" style={{ padding: 0 }}>
        <Disclosure summary="Show the full technical specification">
          <Markdown source={spec.technicalSpec} />
        </Disclosure>
      </div>
    </>
  );
}

function ItemCard({
  item,
  choice,
  result,
  onChoose,
  onRevert,
}: {
  item: ReviewItem;
  choice: DecisionChoice | null;
  result: ItemResult | undefined;
  onChoose: (choice: DecisionChoice) => void;
  onRevert: () => void | Promise<void>;
}): JSX.Element {
  const blocked = item.missingPrerequisites.length > 0;
  const className = [
    'item',
    choice === null ? 'item--undecided' : '',
    choice === 'approve' ? 'item--approved' : '',
    choice === 'defer' ? 'item--deferred' : '',
    choice === 'forgo' ? 'item--forgone' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      <div className="item__head">
        <p className="item__title">{item.title}</p>
        <p className="item__why" id={`why-${item.itemId}`}>
          {item.why}
        </p>

        {/* One quiet line instead of four competing pills. Type is the only
            thing that changes what happens; effort and impact are context. */}
        <div className="item__meta">
          <Badge tone="chip">{TYPE_LABELS[item.type]}</Badge>
          <span>
            {item.effort} effort
            <span className="item__meta-sep"> · </span>
            {item.impact} impact
          </span>
          {item.duplicateOfItemId ? <Badge tone="info">similar to one you did</Badge> : null}
          {result ? <Badge tone={resultTone(result.status)}>{result.status.replace('_', ' ')}</Badge> : null}
        </div>

        {blocked ? (
          <p className="item__flag">
            <IconAlert size={15} />
            <span>Needs {item.missingPrerequisites.join(', ')} — connect it in Settings to enable this.</span>
          </p>
        ) : null}

        {!item.autonomy.autoImplement ? (
          <p className="faint" style={{ marginTop: 8, marginBottom: 0 }}>
            {item.autonomy.reason}
          </p>
        ) : null}

        {result ? (
          <div className="item__result">
            {result.summary}
            {result.reversible ? (
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button className="btn btn--ghost btn--sm" onClick={() => void onRevert()}>
                  Undo
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="item__decide">
        <Segmented
          className="segmented--decide"
          as="radio"
          label={`Decision for ${item.title}`}
          value={choice}
          options={DECISION_OPTIONS}
          onChange={onChoose}
        />
      </div>

      <Disclosure summary="Details & where this came from">
        <dl>
          <dt>Method</dt>
          <dd>{item.proposedMethod}</dd>
          <dt>Permissions</dt>
          <dd>
            {item.scopes.map((scope) => (
              <code key={scope} style={{ marginRight: 5 }}>
                {scope}
              </code>
            ))}
          </dd>
          <dt>Risk</dt>
          <dd>
            {item.riskTier}
            {item.requiresBrowser ? ' · uses the browser' : ''}
          </dd>
          {item.prerequisites.length > 0 ? (
            <>
              <dt>Prerequisites</dt>
              <dd>{item.prerequisites.join(', ')}</dd>
            </>
          ) : null}
          {item.affinity ? (
            <>
              <dt>Your history</dt>
              <dd>
                approved {item.affinity.approve} · skipped {item.affinity.forgo}
              </dd>
            </>
          ) : null}
        </dl>

        {item.sourceExcerpts.length > 0 ? (
          <>
            <p className="faint" style={{ margin: '12px 0 4px' }}>
              Drawn from the source:
            </p>
            {item.sourceExcerpts.map((excerpt) => (
              <blockquote key={excerpt.order} className="excerpt">
                “{excerpt.text}”
                <br />
                <span className="faint">
                  — {PROVENANCE_LABELS[excerpt.provenance]} · {(excerpt.confidence * 100).toFixed(0)}% confidence
                </span>
              </blockquote>
            ))}
          </>
        ) : null}
      </Disclosure>
    </div>
  );
}

function RunResults({ run }: { run: SpecView['run'] }): JSX.Element | null {
  if (!run) return null;
  const active = run.items.filter((item) => item.status !== 'skipped');

  return (
    <>
      <h2>Results</h2>
      {run.dryRun ? (
        <Notice kind="info">
          <strong>Preview only.</strong> Nothing was changed. Approve again without Preview to run for real.
        </Notice>
      ) : null}

      <div className="card">
        <p className="faint" style={{ margin: '0 0 10px' }}>
          {run.status}
          {run.finishedAt ? ` · finished ${relativeTime(run.finishedAt)}` : ''}
        </p>

        {active.length === 0 ? <p className="muted">Nothing ran.</p> : null}

        {active.map((item) => (
          <div key={item.itemId} style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
            <div className="split">
              <strong style={{ fontSize: 14.5 }}>{item.title}</strong>
              <Badge tone={resultTone(item.status)}>{item.status.replace('_', ' ')}</Badge>
            </div>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 14 }}>
              {item.summary}
            </p>
            {item.needsInput ? (
              <p className="item__flag" style={{ marginTop: 6 }}>
                <IconAlert size={15} />
                <span>{item.needsInput}</span>
              </p>
            ) : null}
            {item.artifacts.length > 0 ? (
              <p className="faint" style={{ margin: '6px 0 0' }}>
                Files: {item.artifacts.map((artifact) => <code key={artifact} style={{ marginRight: 5 }}>{artifact}</code>)}
              </p>
            ) : null}
          </div>
        ))}

        {run.actions.length > 0 ? (
          <Disclosure summary={`Full action log (${run.actions.length})`}>
            <ul className="list-reset" style={{ fontSize: 13.5 }}>
              {run.actions.map((action, index) => (
                <li key={index} style={{ padding: '3px 0' }}>
                  <span className="faint tabular">{action.at.slice(11, 19)}</span>{' '}
                  <span style={{ color: action.ok ? 'var(--success)' : 'var(--danger)' }}>
                    {action.ok ? '✓' : '✗'}
                  </span>{' '}
                  {action.action} — <span className="muted">{action.detail}</span>
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : null}
      </div>
    </>
  );
}

function Artifacts({ jobId }: { jobId: string }): JSX.Element | null {
  const { data } = useAsync(() => api.files(jobId), [jobId]);
  if (!data || data.files.length === 0) return null;

  return (
    <>
      <p className="section-label">Files</p>
      <div className="card">
        <p className="faint" style={{ marginTop: 0 }}>
          Everything for this link lives in <code>{data.folderName}</code>.
        </p>
        <ul className="list-reset file-list">
          {data.files
            .filter((file) => !file.startsWith('media/'))
            .map((file) => (
              <li key={file}>
                <span
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0, color: 'var(--text-muted)' }}
                >
                  <IconFile size={15} />
                  <code style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{file}</code>
                </span>
                <a
                  className="btn btn--ghost btn--sm"
                  href={api.fileUrl(jobId, file)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open
                </a>
              </li>
            ))}
        </ul>
        <a className="btn btn--secondary btn--block" href={api.exportUrl(jobId)} download style={{ marginTop: 12 }}>
          <IconDownload size={16} />
          Download this folder (.zip)
        </a>
      </div>
    </>
  );
}

function resultTone(status: ItemResult['status']): 'success' | 'warning' | 'danger' | 'info' | 'default' {
  switch (status) {
    case 'done':
      return 'success';
    case 'partial':
    case 'needs_input':
      return 'warning';
    case 'not_possible':
      return 'danger';
    case 'dry_run':
      return 'info';
    default:
      return 'default';
  }
}
