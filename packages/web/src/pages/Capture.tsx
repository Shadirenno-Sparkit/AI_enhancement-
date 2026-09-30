import { useEffect, useRef, useState } from 'react';
import type { InputKind } from '@aiapp/shared';
import { PLATFORM_LABELS, extractUrl, resolvePlatform } from '@aiapp/shared';
import { ApiError, api } from '../api';
import { Notice, Spinner } from '../components/ui';
import { useOnline } from '../hooks';
import { enqueueCapture, flushQueue, queueStatus } from '../shareQueue';

/**
 * Capture — anything you ran into, in whatever form you ran into it.
 *
 * The share sheet remains the primary path for links. This screen exists for
 * everything the share sheet cannot carry: a thought on the walk home, a
 * recommendation someone said out loud, a photo of a page. They all reduce to
 * text with provenance on the server, so the tabs differ only in how the text
 * is obtained.
 */

const MODES: { kind: InputKind; label: string; hint: string }[] = [
  { kind: 'link', label: 'Link', hint: 'Paste a post, article or video' },
  { kind: 'text', label: 'Note', hint: 'Type what you heard or thought' },
  { kind: 'voice', label: 'Voice', hint: 'Say it out loud' },
  { kind: 'image', label: 'Photo', hint: 'Snap a page, poster or screenshot' },
];

export function Capture({
  onCaptured,
  toast,
}: {
  onCaptured: (jobId: string) => void;
  toast: (message: string) => void;
}): JSX.Element {
  const [mode, setMode] = useState<InputKind>('link');
  const [queued, setQueued] = useState(0);
  const online = useOnline();

  useEffect(() => {
    void queueStatus().then((status) => setQueued(status?.count ?? 0));
  }, []);

  return (
    <>
      {/* The top bar already says "Capture" — the lede does the explaining. */}
      <p className="lede" style={{ marginTop: 4 }}>
        Anything you came across — a link, something someone said, a page worth remembering. It gets read,
        sized up against what you have told the app about yourself, and turned into things you can actually do.
      </p>

      {!online ? (
        <Notice kind="warning">
          You are offline. Links are saved on this device and sent when you reconnect.
        </Notice>
      ) : null}

      {queued > 0 ? (
        <Notice kind="info">
          <strong>{queued}</strong> capture{queued === 1 ? '' : 's'} waiting to send.{' '}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={async () => {
              const result = await flushQueue();
              if (result) {
                setQueued(result.remaining);
                toast(result.sent > 0 ? `Sent ${result.sent}` : 'Still offline');
              }
            }}
          >
            Send now
          </button>
        </Notice>
      ) : null}

      <div className="mode-tabs" role="tablist" aria-label="What are you capturing?">
        {MODES.map((option) => (
          <button
            key={option.kind}
            type="button"
            role="tab"
            aria-selected={mode === option.kind}
            className={`mode-tab${mode === option.kind ? ' is-active' : ''}`}
            onClick={() => setMode(option.kind)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="faint" style={{ marginTop: -4, marginBottom: 12 }}>
        {MODES.find((option) => option.kind === mode)?.hint}
      </p>

      {mode === 'link' && <LinkCapture onCaptured={onCaptured} toast={toast} onQueued={() => setQueued((n) => n + 1)} />}
      {mode === 'text' && <NoteCapture onCaptured={onCaptured} toast={toast} />}
      {mode === 'voice' && <MediaCapture kind="voice" onCaptured={onCaptured} toast={toast} />}
      {mode === 'image' && <MediaCapture kind="image" onCaptured={onCaptured} toast={toast} />}

      <h2>One-tap capture from your phone</h2>
      <div className="card card--flat">
        <p className="muted" style={{ fontSize: 14.5 }}>
          Install this app to your home screen and it registers as a share target — after that,
          &ldquo;AI Enhancement App&rdquo; appears in the normal share sheet inside Instagram, TikTok,
          YouTube and the rest. One tap, no fields, and you keep scrolling.
        </p>
        <ol className="muted" style={{ fontSize: 14.5, paddingLeft: 20, margin: '10px 0 0' }}>
          <li>
            <strong>iOS (Safari):</strong> Share → <em>Add to Home Screen</em>.
          </li>
          <li>
            <strong>Android (Chrome):</strong> menu → <em>Install app</em> / <em>Add to Home screen</em>.
          </li>
          <li>Open it once from the home screen so it registers.</li>
        </ol>
        <p className="faint" style={{ marginTop: 10 }}>
          Share targets need the installed app, and the app must be served over HTTPS (or localhost).
        </p>
      </div>
    </>
  );
}

// ─── Link ────────────────────────────────────────────────────────────────────

function LinkCapture({
  onCaptured,
  toast,
  onQueued,
}: {
  onCaptured: (jobId: string) => void;
  toast: (message: string) => void;
  onQueued: () => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detectedUrl = extractUrl(text);
  const platform = detectedUrl ? resolvePlatform(detectedUrl) : null;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!detectedUrl) {
      setError('That does not contain a web link. Switch to Note to capture it as text instead.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await api.capture({ url: text.trim(), note: note.trim() || undefined, captureSource: 'paste' });
      setText('');
      setNote('');
      toast(result.deduped ? 'Already captured — opening it' : 'Captured. Reading it now.');
      onCaptured(result.jobId);
    } catch (err) {
      // Offline or the server is unreachable: queue it rather than lose it (BR-C7).
      if (!(err instanceof ApiError) || err.status >= 500) {
        enqueueCapture({
          clientRef: `paste-${Date.now()}`,
          url: detectedUrl,
          sharedText: text.trim(),
          note: note.trim() || null,
          captureSource: 'paste',
          queuedAt: new Date().toISOString(),
        });
        setText('');
        setNote('');
        onQueued();
        toast('Saved offline — it will send when you reconnect.');
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error ? <Notice kind="danger">{error}</Notice> : null}
      <form onSubmit={submit} className="card">
        <div className="field">
          <label className="field__label" htmlFor="capture-url">
            Link or shared text
          </label>
          <textarea
            id="capture-url"
            className="textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="https://www.instagram.com/reel/…  — or paste the whole caption"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
          {detectedUrl ? (
            <p className="faint" style={{ marginTop: 6 }}>
              Found a {platform ? PLATFORM_LABELS[platform] : 'web'} link: <code>{truncate(detectedUrl, 52)}</code>
            </p>
          ) : null}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="capture-note">
            Note <span className="faint">(optional — steers the analysis)</span>
          </label>
          <input
            id="capture-note"
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="I care about the scheduling part"
            maxLength={200}
          />
        </div>

        <button className="btn btn--block" type="submit" disabled={busy || !text.trim()}>
          {busy ? <Spinner label="Capturing" /> : null}
          Capture
        </button>
      </form>
    </>
  );
}

// ─── Typed note ──────────────────────────────────────────────────────────────

function NoteCapture({
  onCaptured,
  toast,
}: {
  onCaptured: (jobId: string) => void;
  toast: (message: string) => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.captureAny({ kind: 'text', text: text.trim(), captureSource: 'paste' });
      setText('');
      toast(result.deduped ? 'You already captured that' : 'Captured. Reading it now.');
      onCaptured(result.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not capture that.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error ? <Notice kind="danger">{error}</Notice> : null}
      <form onSubmit={submit} className="card">
        <div className="field">
          <label className="field__label" htmlFor="capture-note-body">
            What did you come across?
          </label>
          <textarea
            id="capture-note-body"
            className="textarea"
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Someone at the gym said Atomic Habits is worth reading — the bit about attaching a new habit to one you already do."
            required
          />
          <p className="faint" style={{ marginTop: 6 }}>
            Write it however you would say it. No link needed.
          </p>
        </div>
        <button className="btn btn--block" type="submit" disabled={busy || !text.trim()}>
          {busy ? <Spinner label="Capturing" /> : null}
          Capture
        </button>
      </form>
    </>
  );
}

// ─── Voice and photo ─────────────────────────────────────────────────────────

/**
 * Voice and photo share one component because they differ only in what the file
 * picker accepts and what the server does with the bytes. On a phone, `capture`
 * on the input opens the microphone or camera directly rather than the gallery.
 */
function MediaCapture({
  kind,
  onCaptured,
  toast,
}: {
  kind: 'voice' | 'image';
  onCaptured: (jobId: string) => void;
  toast: (message: string) => void;
}): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isVoice = kind === 'voice';
  const MAX_BYTES = 10 * 1024 * 1024;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 10 MB.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const data = await readAsBase64(file);
      const result = await api.captureAny({
        kind,
        media: { data, mimeType: file.type || (isVoice ? 'audio/mpeg' : 'image/jpeg'), filename: file.name },
        text: note.trim() || undefined,
        captureSource: 'paste',
      });
      setFile(null);
      setNote('');
      if (inputRef.current) inputRef.current.value = '';
      toast(result.deduped ? 'You already captured that' : 'Captured. Reading it now.');
      onCaptured(result.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that file.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error ? <Notice kind="danger">{error}</Notice> : null}
      <form onSubmit={submit} className="card">
        <div className="field">
          <label className="field__label" htmlFor={`capture-${kind}`}>
            {isVoice ? 'Recording' : 'Photo'}
          </label>
          <input
            ref={inputRef}
            id={`capture-${kind}`}
            className="input"
            type="file"
            accept={isVoice ? 'audio/*' : 'image/*'}
            capture={isVoice ? undefined : 'environment'}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
          />
          <p className="faint" style={{ marginTop: 6 }}>
            {isVoice
              ? 'On a phone this opens your recorder. Up to 10 MB — about ten minutes of speech.'
              : 'On a phone this opens the camera. The text in the image is what gets read.'}
          </p>
        </div>

        <div className="field">
          <label className="field__label" htmlFor={`capture-${kind}-note`}>
            Context <span className="faint">(optional)</span>
          </label>
          <input
            id={`capture-${kind}-note`}
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={isVoice ? 'Overheard at the conference' : 'Poster at the library'}
            maxLength={200}
          />
        </div>

        <button className="btn btn--block" type="submit" disabled={busy || !file}>
          {busy ? <Spinner label={isVoice ? 'Transcribing' : 'Reading'} /> : null}
          Capture
        </button>
      </form>
    </>
  );
}

/** FileReader gives a `data:` URL; the server accepts that or a bare payload. */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
