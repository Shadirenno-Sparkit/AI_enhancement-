import { useCallback, useEffect, useState } from 'react';
import type { User } from '@aiapp/shared';
import { api, loadTokens, saveTokens, type Capabilities } from './api';
import { Notice, Spinner, Toast } from './components/ui';
import { useAsync, useHashRoute } from './hooks';
import { flushQueue, registerServiceWorker } from './shareQueue';
import { Auth } from './pages/Auth';
import { Capture } from './pages/Capture';
import { Digest } from './pages/Digest';
import { Library } from './pages/Library';
import { Review } from './pages/Review';
import { Settings } from './pages/Settings';

const TABS = [
  { path: '/library', icon: '📥', label: 'Inbox' },
  { path: '/capture', icon: '＋', label: 'Capture' },
  { path: '/digest', icon: '📊', label: 'Digest' },
  { path: '/settings', icon: '⚙︎', label: 'Settings' },
];

export function App(): JSX.Element {
  const [route, navigate] = useHashRoute();
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [pendingCaptures, setPendingCaptures] = useState(0);

  const toast = useCallback((message: string) => setToastMessage(message), []);
  const capabilities = useAsync<Capabilities>(() => api.capabilities(), []);

  // Restore the session on load, then flush anything the service worker queued
  // while the app was closed — a share captured offline lands here.
  useEffect(() => {
    let cancelled = false;

    const boot = async (): Promise<void> => {
      if (loadTokens()) {
        try {
          const result = await api.me();
          if (!cancelled) setUser(result.user);
        } catch {
          saveTokens(null);
        }
      }
      if (!cancelled) setBooting(false);

      await registerServiceWorker((result) => {
        setPendingCaptures(result.remaining);
        if (result.sent > 0) toast(`Sent ${result.sent} queued capture${result.sent === 1 ? '' : 's'}`);
      });
    };

    void boot();
    return () => {
      cancelled = true;
    };
  }, [toast]);

  // A share arrives as a redirect to #/captured — flush immediately so the
  // confirmation screen reflects a real submission.
  useEffect(() => {
    if (!user) return;
    if (!route.startsWith('/captured')) return;

    void flushQueue().then((result) => {
      if (!result) return;
      setPendingCaptures(result.remaining);
      if (result.sent > 0) toast('Captured — processing now');
    });
  }, [route, user, toast]);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Already invalid server-side; clearing locally is what matters.
    }
    saveTokens(null);
    setUser(null);
    navigate('/library');
  }, [navigate]);

  if (booting) {
    return (
      <div className="auth-shell">
        <p className="muted">
          <Spinner label="Starting" /> Starting…
        </p>
      </div>
    );
  }

  if (!user) {
    return (
      <Auth
        capabilities={capabilities.data}
        onSignedIn={(signedIn) => {
          setUser(signedIn);
          navigate('/library');
          void flushQueue();
        }}
      />
    );
  }

  const activeTab = TABS.find((tab) => route.startsWith(tab.path))?.path ?? '/library';

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__inner">
          <img src="/icon.svg" alt="" width={26} height={26} style={{ borderRadius: 7 }} />
          <h1 className="topbar__title">AI Enhancement App</h1>
          {pendingCaptures > 0 ? (
            <span className="badge badge--warning">{pendingCaptures} queued</span>
          ) : null}
        </div>
      </header>

      <main className="app__main">
        <Router
          route={route}
          navigate={navigate}
          user={user}
          capabilities={capabilities.data}
          onUserChanged={setUser}
          onSignOut={() => void signOut()}
          toast={toast}
        />
      </main>

      <nav className="tabbar" aria-label="Main">
        {TABS.map((tab) => (
          <a
            key={tab.path}
            className="tabbar__item"
            href={`#${tab.path}`}
            aria-current={activeTab === tab.path ? 'page' : undefined}
          >
            <span className="tabbar__icon" aria-hidden="true">
              {tab.icon}
            </span>
            {tab.label}
          </a>
        ))}
      </nav>

      <Toast message={toastMessage} onDone={() => setToastMessage(null)} />
    </div>
  );
}

function Router({
  route,
  navigate,
  user,
  capabilities,
  onUserChanged,
  onSignOut,
  toast,
}: {
  route: string;
  navigate: (path: string) => void;
  user: User;
  capabilities: Capabilities | null;
  onUserChanged: (user: User) => void;
  onSignOut: () => void;
  toast: (message: string) => void;
}): JSX.Element {
  const jobMatch = route.match(/^\/job\/([\w-]+)/);
  if (jobMatch?.[1]) {
    return <Review jobId={jobMatch[1]} onBack={() => navigate('/library')} toast={toast} />;
  }

  if (route.startsWith('/captured')) {
    return <Captured onDone={() => navigate('/library')} />;
  }

  if (route.startsWith('/capture')) {
    const error = new URLSearchParams(route.split('?')[1] ?? '').get('error');
    return (
      <>
        {error === 'no-link' ? (
          <Notice kind="warning">
            What you shared did not contain a web link. Try sharing the post link itself, or paste it below.
          </Notice>
        ) : null}
        <Capture onCaptured={(jobId) => navigate(`/job/${jobId}`)} toast={toast} />
      </>
    );
  }

  if (route.startsWith('/digest')) {
    return <Digest onOpen={(jobId) => navigate(`/job/${jobId}`)} />;
  }

  if (route.startsWith('/settings')) {
    return (
      <Settings
        user={user}
        capabilities={capabilities}
        onUserChanged={onUserChanged}
        onSignOut={onSignOut}
        toast={toast}
      />
    );
  }

  return <Library onOpen={(entry) => navigate(`/job/${entry.jobId}`)} />;
}

/**
 * The screen the OS share sheet lands on. It exists to be dismissed fast:
 * confirm, then get out of the way (BR-C5).
 */
function Captured({ onDone }: { onDone: () => void }): JSX.Element {
  useEffect(() => {
    const timer = window.setTimeout(onDone, 2200);
    return () => window.clearTimeout(timer);
  }, [onDone]);

  return (
    <div className="empty" style={{ paddingTop: 80 }}>
      <div className="empty__icon" aria-hidden="true">
        ✓
      </div>
      <h2 style={{ margin: '0 0 6px' }}>Captured</h2>
      <p className="muted">Processing it now — you will be notified when the spec is ready.</p>
      <button className="btn btn--secondary" onClick={onDone} style={{ marginTop: 12 }}>
        Go to inbox
      </button>
    </div>
  );
}
