import { useEffect, useState } from 'react';
import { PLATFORM_LABELS, extractUrl, resolvePlatform } from '@aiapp/shared';
import { ApiError, api } from '../api';
import { Notice, Spinner } from '../components/ui';
import { useOnline } from '../hooks';
import { enqueueCapture, flushQueue, queueStatus } from '../shareQueue';

/**
 * Manual capture — the paste fallback (BR-C3) and the place the install
 * instructions live. The share sheet is the primary path; this is what makes
 * the app usable before it is installed, and on desktop.
 */
export function Capture({
  onCaptured,
  toast,
}: {
  onCaptured: (jobId: string) => void;
  toast: (message: string) => void;
}): JSX.Element {
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(0);
  const online = useOnline();

  useEffect(() => {
    void queueStatus().then((status) => setQueued(status?.count ?? 0));
  }, []);

  const detectedUrl = extractUrl(text);
  const platform = detectedUrl ? resolvePlatform(detectedUrl) : null;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!detectedUrl) {
      setError('That does not contain a web link. Paste the post URL, or the text you copied from the app.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await api.capture({
        url: text.trim(),
        note: note.trim() || undefined,
        captureSource: 'paste',
      });
      setText('');
      setNote('');
      toast(result.deduped ? 'Already captured — opening it' : 'Captured. Processing now.');
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
        setQueued((count) => count + 1);
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
      {/* The top bar already says "Capture" — the lede does the explaining. */}
      <p className="lede" style={{ marginTop: 4 }}>
        Paste anything you copied from a social app — the whole caption is fine, the link is found inside it.
      </p>

      {!online ? (
        <Notice kind="warning">
          You are offline. Captures are saved on this device and sent automatically when you reconnect.
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

      <p className="section-label">One-tap capture from your phone</p>
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

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
