import { useState } from 'react';
import type { User } from '@aiapp/shared';
import { ApiError, api, saveTokens, type Capabilities } from '../api';
import { Notice, Spinner } from '../components/ui';

export function Auth({
  capabilities,
  onSignedIn,
}: {
  capabilities: Capabilities | null;
  onSignedIn: (user: User) => void;
}): JSX.Element {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === 'signup'
          ? await api.signup(email, password, displayName || undefined)
          : await api.login(email, password);

      saveTokens({
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresAt: Date.now() + result.expiresIn * 1000,
      });
      onSignedIn(result.user);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not reach the server. Check that it is running and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <img className="auth-logo" src="/icon.svg" alt="" />
        <h1 style={{ textAlign: 'center', fontSize: 21, margin: '0 0 4px' }}>AI Enhancement App</h1>
        <p className="lede" style={{ textAlign: 'center', fontSize: 14 }}>
          {mode === 'login'
            ? 'Sign in to review and approve what your captured links turned into.'
            : 'Create an account to start capturing links.'}
        </p>

        {error ? <Notice kind="danger">{error}</Notice> : null}

        {mode === 'signup' ? (
          <div className="field">
            <label className="field__label" htmlFor="name">
              Your name <span className="faint">(optional)</span>
            </label>
            <input
              id="name"
              className="input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="name"
            />
          </div>
        ) : null}

        <div className="field">
          <label className="field__label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            required
            minLength={mode === 'signup' ? 10 : 1}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          />
          {mode === 'signup' ? <p className="faint" style={{ marginTop: 5 }}>At least 10 characters.</p> : null}
        </div>

        <button className="btn btn--block" type="submit" disabled={busy}>
          {busy ? <Spinner label="Working" /> : null}
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </button>

        {capabilities?.signupOpen !== false || mode === 'signup' ? (
          <button
            type="button"
            className="btn btn--ghost btn--block"
            style={{ marginTop: 10 }}
            onClick={() => {
              setMode(mode === 'login' ? 'signup' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Sign in'}
          </button>
        ) : null}

        {capabilities && !capabilities.analysis.live ? (
          <p className="faint" style={{ marginTop: 16, textAlign: 'center' }}>
            This deployment is running the offline analyzer — links are still extracted and specced, just
            without a model. Add <code>ANTHROPIC_API_KEY</code> for full-quality analysis.
          </p>
        ) : null}
      </form>
    </div>
  );
}
