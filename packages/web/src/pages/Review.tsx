import { useEffect, useMemo, useState } from 'react';
import type { DecisionChoice, ItemResult, Pathway, Provenance } from '@aiapp/shared';
import { ITEM_TYPE_LABELS, PATHWAY_STANCE_LABELS, PLATFORM_LABELS } from '@aiapp/shared';
import { api, type ReviewItem, type SpecView } from '../api';
import { Badge, Disclosure, Markdown, Notice, Progress, Spinner, relativeTime } from '../components/ui';
import { useAsync } from '../hooks';

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

/**
 * The review screen (spec §4.5).
 *
 * While the pipeline runs it shows honest progress; once a spec exists it
 * becomes the approve/forgo gate. Decisions default to unselected — nothing is
 * opt-out (BR-R2).
 */
export function Review({
  jobId,
  onBack,
  toast,
}: {
  jobId: string;
  onBack: () => void;
  toast: (message: string) => void;
}): JSX.Element {
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
      <button className="btn btn--ghost btn--sm" onClick={onBack} style={{ marginBottom: 6 }}>
        ← Back
      </button>

      <h1>{job.title ?? `${PLATFORM_LABELS[job.platform]} post`}</h1>
      <p className="faint" style={{ marginBottom: 14 }}>
        {PLATFORM_LABELS[job.platform]} · captured {relativeTime(job.createdAt)} ·{' '}
        <a href={job.url} target="_blank" rel="noopener noreferrer">
          open original
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
              <Badge key={method}>{PROVENANCE_LABELS[method]}</Badge>
            ))}
          </div>
        ) : null}
      </div>

      {spec.noActionableItems || spec.items.length === 0 ? (
        <Notice kind="info">
          Nothing actionable was found here — nothing was invented to fill the gap.
        </Notice>
      ) : (
        <>
          {spec.pathways.length > 1 ? (
            <PathwayChooser
              pathways={spec.pathways}
              itemsById={new Map(spec.items.map((item) => [item.itemId, item]))}
              disabled={submitting}
              onChoose={(pathway) => {
                // Picking a route pre-selects its items and forgoes the rest.
                // It stages the choice rather than submitting, so the user can
                // still amend an individual item before committing.
                const onRoute = new Set(pathway.itemIds);
                setSelection(
                  Object.fromEntries(
                    spec.items.map((item) => [item.itemId, onRoute.has(item.itemId) ? 'approve' : 'forgo']),
                  ),
                );
                toast(`“${pathway.label}” selected — review below, then confirm.`);
              }}
            />
          ) : null}

          <div className="section-head">
            <h2>
              {spec.items.length} thing{spec.items.length === 1 ? '' : 's'} you could do
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

      {run ? <RunResults run={run} spec={spec} onChanged={onChanged} toast={toast} /> : null}

      <h2>Technical spec</h2>
      <div className="card">
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
  onChoose: (choice: DecisionChoice | null) => void;
  onRevert: () => void | Promise<void>;
}): JSX.Element {
  const blocked = item.missingPrerequisites.length > 0;
  const className = [
    'item',
    choice === 'approve' ? 'item--approved' : '',
    choice === 'forgo' ? 'item--forgone' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      <div className="item__head">
        <input
          type="checkbox"
          id={`item-${item.itemId}`}
          checked={choice === 'approve'}
          onChange={(e) => onChoose(e.target.checked ? 'approve' : 'forgo')}
          style={{ width: 24, height: 24, marginTop: 2, accentColor: 'var(--accent)' }}
          aria-describedby={`why-${item.itemId}`}
        />
        <div className="item__body">
          <label className="item__title" htmlFor={`item-${item.itemId}`}>
            {item.title}
          </label>
          <p className="item__why" id={`why-${item.itemId}`}>
            {item.why}
          </p>

          <div className="badge-row">
            <Badge tone="accent">{ITEM_TYPE_LABELS[item.type]}</Badge>
            <Badge>{item.effort} effort</Badge>
            <Badge tone={item.impact === 'high' ? 'success' : 'default'}>{item.impact} impact</Badge>
            {item.riskTier !== 'safe' ? <Badge tone="warning">{item.riskTier}</Badge> : null}
            {item.requiresBrowser ? <Badge tone="info">uses browser</Badge> : null}
            {item.duplicateOfItemId ? <Badge tone="info">similar to one you did</Badge> : null}
            {result ? <Badge tone={resultTone(result.status)}>{result.status.replace('_', ' ')}</Badge> : null}
          </div>

          {blocked ? (
            <p className="faint" style={{ marginTop: 8, color: 'var(--warning)' }}>
              ⚠︎ Needs {item.missingPrerequisites.join(', ')} — connect it in Settings to enable this.
            </p>
          ) : null}

          {!item.autonomy.autoImplement ? (
            <p className="faint" style={{ marginTop: 6 }}>
              {item.autonomy.reason}
            </p>
          ) : null}

          {result ? (
            <p className="faint" style={{ marginTop: 8, color: 'var(--text)' }}>
              {result.summary}
            </p>
          ) : null}

          <div className="btn-row" style={{ marginTop: 10 }}>
            <button
              className={choice === 'defer' ? 'btn btn--sm' : 'btn btn--ghost btn--sm'}
              onClick={() => onChoose(choice === 'defer' ? null : 'defer')}
            >
              Maybe later
            </button>
            {result?.reversible ? (
              <button className="btn btn--ghost btn--sm" onClick={() => void onRevert()}>
                Undo
              </button>
            ) : null}
          </div>
        </div>
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

function RunResults({
  run,
  spec,
  onChanged,
  toast,
}: {
  run: SpecView['run'];
  spec: SpecView['spec'];
  onChanged: () => void;
  toast: (message: string) => void;
}): JSX.Element | null {
  const [confirming, setConfirming] = useState(false);
  if (!run) return null;
  const active = run.items.filter((item) => item.status !== 'skipped');
  // Items the trust dial approved but held. Releasing them is a separate,
  // explicit act — not a re-approval.
  const heldBack = run.items.filter((item) => item.status === 'needs_input');

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
          Run {run.runId} · {run.status}
          {run.finishedAt ? ` · finished ${relativeTime(run.finishedAt)}` : ''}
        </p>

        {active.length === 0 ? <p className="muted">Nothing ran.</p> : null}

        {heldBack.length > 0 ? (
          <div className="confirm-strip">
            <p style={{ margin: 0, fontSize: 14 }}>
              <strong>
                {heldBack.length} item{heldBack.length === 1 ? '' : 's'} waiting on you.
              </strong>{' '}
              Your trust setting holds higher-risk items until you say yes to them specifically.
            </p>
            <button
              type="button"
              className="btn btn--sm"
              disabled={confirming}
              onClick={async () => {
                setConfirming(true);
                try {
                  await api.confirmItems(spec.specId, heldBack.map((item) => item.itemId));
                  toast(`Running ${heldBack.length} confirmed item${heldBack.length === 1 ? '' : 's'}…`);
                  onChanged();
                } catch (err) {
                  toast(err instanceof Error ? err.message : 'Could not confirm those.');
                } finally {
                  setConfirming(false);
                }
              }}
            >
              {confirming ? 'Confirming…' : `Yes, run ${heldBack.length === 1 ? 'it' : 'them'}`}
            </button>
          </div>
        ) : null}

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
              <p className="faint" style={{ margin: '4px 0 0', color: 'var(--warning)' }}>
                → {item.needsInput}
              </p>
            ) : null}
            {item.artifacts.length > 0 ? (
              <p className="faint" style={{ margin: '4px 0 0' }}>
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
                  <span className="faint">{action.at.slice(11, 19)}</span> {action.ok ? '✓' : '✗'} {action.action} —{' '}
                  <span className="muted">{action.detail}</span>
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
      <h2>Files</h2>
      <div className="card">
        <p className="faint" style={{ marginTop: 0 }}>
          Everything for this link lives in <code>{data.folderName}</code>.
        </p>
        <ul className="list-reset file-list">
          {data.files
            .filter((file) => !file.startsWith('media/'))
            .map((file) => (
              <li key={file}>
                <code style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{file}</code>
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
          ⬇ Download this folder (.zip)
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


/**
 * The route picker.
 *
 * The same capture can usually be acted on more than one way — buy the book,
 * read a summary, or turn its argument into a weekly routine. Showing those as
 * competing routes rather than one flat checklist is the difference between
 * "here is everything it said" and "here is what I would do if I were you".
 *
 * The recommended route leads, and its rationale names the facts it leaned on,
 * so a personalized suggestion can be checked rather than merely trusted.
 */
function PathwayChooser({
  pathways,
  itemsById,
  disabled,
  onChoose,
}: {
  pathways: Pathway[];
  itemsById: Map<string, ReviewItem>;
  disabled: boolean;
  onChoose: (pathway: Pathway) => void;
}): JSX.Element {
  // Recommended first: it is the answer to "just tell me what to do".
  const ordered = [...pathways].sort((a, b) => Number(b.recommended) - Number(a.recommended));

  return (
    <section className="pathways">
      <div className="section-head">
        <h2>How you could go about it</h2>
        <span className="faint">Pick one, or mix and match below</span>
      </div>

      <div className="pathway-grid">
        {ordered.map((pathway) => {
          const items = pathway.itemIds
            .map((itemId) => itemsById.get(itemId))
            .filter((item): item is ReviewItem => Boolean(item));

          return (
            <article
              key={pathway.pathwayId}
              className={`pathway-card${pathway.recommended ? ' is-recommended' : ''}`}
            >
              <header className="pathway-head">
                <div className="pathway-titles">
                  <h3>{pathway.label}</h3>
                  <Badge>{PATHWAY_STANCE_LABELS[pathway.stance]}</Badge>
                </div>
                {pathway.recommended ? <Badge tone="success">Recommended for you</Badge> : null}
              </header>

              {pathway.rationale ? <p className="pathway-why">{pathway.rationale}</p> : null}

              {pathway.groundedInFacts.length > 0 ? (
                <p className="faint pathway-grounds">
                  Because you told us about:{' '}
                  {pathway.groundedInFacts.map((fact) => fact.replace(/_/g, ' ')).join(', ')}
                </p>
              ) : null}

              <ul className="pathway-items">
                {items.map((item) => (
                  <li key={item.itemId}>
                    <span className="pathway-item-type">{ITEM_TYPE_LABELS[item.type]}</span>
                    {item.title}
                  </li>
                ))}
              </ul>

              <footer className="pathway-foot">
                <span className="faint">
                  {pathway.estimatedMinutes > 0 ? `~${formatMinutes(pathway.estimatedMinutes)}` : 'No time from you'}
                  {' · '}
                  {pathway.estimatedCostUsd > 0 ? `$${pathway.estimatedCostUsd.toFixed(2)}` : 'Free'}
                </span>
                <button
                  type="button"
                  className={`btn btn--sm${pathway.recommended ? '' : ' btn--ghost'}`}
                  disabled={disabled}
                  onClick={() => onChoose(pathway)}
                >
                  Choose this
                </button>
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} hr${hours === 1 ? '' : 's'}`;
}
