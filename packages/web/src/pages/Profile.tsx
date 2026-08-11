import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FactCategory, ProfileFact, ProfileResponse } from '@aiapp/shared';
import { FACT_CATEGORIES, FACT_CATEGORY_LABELS } from '@aiapp/shared';
import { api } from '../api';
import { Empty, Notice, Spinner, Toast } from '../components/ui';

/**
 * The life context graph, as a page.
 *
 * This is the screen that decides whether the rest of the product is any good.
 * With an empty profile the app can only give advice that would suit anybody;
 * with a filled one it can say "get the audiobook, because you listen on the
 * commute". So the page leads with how complete the picture is, and suggests
 * the next thing worth telling it.
 */

/**
 * Starter prompts per category. These are the questions that most change a
 * recommendation — not an exhaustive interview, just the ones that pay.
 */
const SUGGESTIONS: Partial<Record<FactCategory, { key: string; label: string; placeholder: string }[]>> = {
  identity: [
    { key: 'city', label: 'Where you live', placeholder: 'Toronto, Canada' },
    { key: 'timezone', label: 'Your timezone', placeholder: 'America/Toronto' },
  ],
  household: [
    { key: 'household', label: 'Who you live with', placeholder: 'Partner and two kids, 6 and 9' },
  ],
  device: [
    { key: 'phone', label: 'Your phone', placeholder: 'iPhone 15 Pro' },
    { key: 'computer', label: 'Your computer', placeholder: 'MacBook Pro, macOS' },
  ],
  service: [
    { key: 'audiobooks', label: 'Audiobook service', placeholder: 'Audible, 1 credit a month' },
    { key: 'bank', label: 'Bank', placeholder: 'Chase' },
    { key: 'ai_subscription', label: 'AI subscription', placeholder: 'Claude Pro' },
  ],
  tool: [
    { key: 'notes_app', label: 'Where you keep notes', placeholder: 'Notion' },
    { key: 'work_chat', label: 'Work chat', placeholder: 'Slack' },
  ],
  preference: [
    { key: 'reading_format', label: 'How you prefer to read', placeholder: 'Audiobooks — I listen on the commute' },
    { key: 'communication_style', label: 'How you like things written', placeholder: 'Short, direct, no preamble' },
    { key: 'best_hours', label: 'When you do your best work', placeholder: 'Early mornings' },
  ],
  goal: [{ key: 'current_goal', label: 'What you are working towards', placeholder: 'Ship the consulting practice' }],
  constraint: [
    { key: 'time_per_week', label: 'Time you can spare weekly', placeholder: 'About 3 hours' },
    { key: 'budget', label: 'What you will spend on tools', placeholder: 'Up to $50/month' },
  ],
  routine: [{ key: 'commute', label: 'Your commute', placeholder: '40 minutes each way, driving' }],
  skill: [{ key: 'background', label: 'What you already know', placeholder: 'Consulting, some Python' }],
};

export function Profile(): JSX.Element {
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProfile(await api.profile());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your profile.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byCategory = useMemo(() => {
    const map = new Map<FactCategory, ProfileFact[]>();
    for (const fact of profile?.facts ?? []) {
      const list = map.get(fact.category) ?? [];
      list.push(fact);
      map.set(fact.category, list);
    }
    return map;
  }, [profile]);

  async function addFact(category: FactCategory, key: string, value: string): Promise<void> {
    if (!value.trim()) return;
    setBusy(key);
    try {
      await api.addFact({ category, key, value });
      await load();
      setToast('Saved.');
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Could not save that.');
    } finally {
      setBusy(null);
    }
  }

  async function confirm(fact: ProfileFact): Promise<void> {
    setBusy(fact.factId);
    try {
      await api.confirmFact(fact.factId);
      await load();
      setToast(`Added “${fact.value}”.`);
    } finally {
      setBusy(null);
    }
  }

  async function remove(fact: ProfileFact, wasPending: boolean): Promise<void> {
    setBusy(fact.factId);
    try {
      await api.deleteFact(fact.factId);
      await load();
      setToast(wasPending ? 'Dismissed.' : 'Removed.');
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <Spinner label="Loading your profile…" />;
  if (error) return <Notice kind="danger">{error}</Notice>;
  if (!profile)
    return (
      <Empty icon="\u{1F464}" title="No profile yet">
        Add something about yourself so recommendations can be tailored to you.
      </Empty>
    );

  const percent = Math.round(profile.completeness * 100);

  return (
    <div className="page profile">
      <header className="page-head">
        <h1>About you</h1>
        <p className="muted">
          Everything here shapes what gets recommended. Nothing is shared, and you can delete any of it.
        </p>
      </header>

      <section className="profile-meter" aria-label="How well the app knows you">
        <div className="meter-row">
          <div className="meter-track">
            <div className="meter-fill" style={{ width: `${Math.max(4, percent)}%` }} />
          </div>
          <strong className="meter-value">{percent}%</strong>
        </div>
        <p className="muted small">
          {percent === 0
            ? 'The app knows nothing about you yet, so recommendations will be generic. Add a few things below.'
            : percent < 40
              ? 'Enough to start. The more it knows, the more the routes it suggests will actually fit you.'
              : 'Good — recommendations can be genuinely tailored to how you work.'}
        </p>
      </section>

      {profile.pending.length > 0 && (
        <section className="profile-pending">
          <h2>Noticed about you</h2>
          <p className="muted small">
            Picked up while reading things you captured. Nothing is used until you say it is right.
          </p>
          <ul className="fact-list">
            {profile.pending.map((fact) => (
              <li key={fact.factId} className="fact pending">
                <div className="fact-body">
                  <span className="fact-key">{fact.key.replace(/_/g, ' ')}</span>
                  <span className="fact-value">{fact.value}</span>
                  {fact.detail && <span className="muted small">{fact.detail}</span>}
                </div>
                <div className="fact-actions">
                  <button
                    type="button"
                    className="btn small"
                    disabled={busy === fact.factId}
                    onClick={() => void confirm(fact)}
                  >
                    That&rsquo;s right
                  </button>
                  <button
                    type="button"
                    className="btn small ghost"
                    disabled={busy === fact.factId}
                    onClick={() => void remove(fact, true)}
                  >
                    No
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {FACT_CATEGORIES.map((category) => {
        const facts = byCategory.get(category) ?? [];
        const suggestions = (SUGGESTIONS[category] ?? []).filter(
          (suggestion) => !facts.some((fact) => fact.key === suggestion.key),
        );
        if (facts.length === 0 && suggestions.length === 0) return null;

        return (
          <section key={category} className="profile-section">
            <h2>{FACT_CATEGORY_LABELS[category]}</h2>

            {facts.length > 0 && (
              <ul className="fact-list">
                {facts.map((fact) => (
                  <li key={fact.factId} className="fact">
                    <div className="fact-body">
                      <span className="fact-key">{fact.key.replace(/_/g, ' ')}</span>
                      <span className="fact-value">{fact.value}</span>
                    </div>
                    <button
                      type="button"
                      className="btn small ghost"
                      disabled={busy === fact.factId}
                      onClick={() => void remove(fact, false)}
                      aria-label={`Remove ${fact.key}`}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {suggestions.map((suggestion) => (
              <FactPrompt
                key={suggestion.key}
                label={suggestion.label}
                placeholder={suggestion.placeholder}
                busy={busy === suggestion.key}
                onSubmit={(value) => void addFact(category, suggestion.key, value)}
              />
            ))}
          </section>
        );
      })}

      <section className="profile-section">
        <h2>Anything else</h2>
        <FreeFact busy={busy === '__free'} onSubmit={(category, key, value) => void addFact(category, key, value)} />
      </section>

      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function FactPrompt({
  label,
  placeholder,
  busy,
  onSubmit,
}: {
  label: string;
  placeholder: string;
  busy: boolean;
  onSubmit: (value: string) => void;
}): JSX.Element {
  const [value, setValue] = useState('');

  return (
    <form
      className="fact-prompt"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value);
        setValue('');
      }}
    >
      <label>
        <span className="muted small">{label}</span>
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <button type="submit" className="btn small" disabled={busy || !value.trim()}>
        Add
      </button>
    </form>
  );
}

function FreeFact({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (category: FactCategory, key: string, value: string) => void;
}): JSX.Element {
  const [category, setCategory] = useState<FactCategory>('preference');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  return (
    <form
      className="fact-prompt free"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(category, key, value);
        setKey('');
        setValue('');
      }}
    >
      <select value={category} onChange={(event) => setCategory(event.target.value as FactCategory)}>
        {FACT_CATEGORIES.map((option) => (
          <option key={option} value={option}>
            {FACT_CATEGORY_LABELS[option]}
          </option>
        ))}
      </select>
      <input type="text" value={key} placeholder="What it is" onChange={(event) => setKey(event.target.value)} />
      <input
        type="text"
        value={value}
        placeholder="What it is for you"
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className="btn small" disabled={busy || !key.trim() || !value.trim()}>
        Add
      </button>
    </form>
  );
}
