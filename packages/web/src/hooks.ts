import { useCallback, useEffect, useRef, useState } from 'react';

/** Hash-based routing: `#/library`, `#/job/job_123`. */
export function useHashRoute(): [string, (path: string) => void] {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/');

  useEffect(() => {
    const onChange = (): void => setRoute(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((path: string) => {
    window.location.hash = path;
  }, []);

  return [route, navigate];
}

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Runs an async loader, optionally re-running on an interval.
 *
 * `stopWhen` lets a caller poll a job until it settles and then stop — the
 * pipeline is asynchronous, so most screens need exactly this shape.
 */
export function useAsync<T>(
  loader: () => Promise<T>,
  deps: unknown[],
  options: { intervalMs?: number; stopWhen?: (data: T) => boolean; enabled?: boolean } = {},
): AsyncState<T> & { reload: () => void } {
  const { intervalMs, stopWhen, enabled = true } = options;
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: enabled, error: null });
  const [nonce, setNonce] = useState(0);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const stopRef = useRef(stopWhen);
  stopRef.current = stopWhen;

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, loading: false, error: null });
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    const run = async (): Promise<void> => {
      try {
        const data = await loaderRef.current();
        if (cancelled) return;
        setState({ data, loading: false, error: null });
        if (intervalMs && !stopRef.current?.(data)) {
          timer = window.setTimeout(run, intervalMs);
        }
      } catch (err) {
        if (cancelled) return;
        setState((previous) => ({
          data: previous.data,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
        // Keep polling through a transient failure rather than freezing the view.
        if (intervalMs) timer = window.setTimeout(run, intervalMs * 2);
      }
    };

    setState((previous) => ({ ...previous, loading: previous.data === null }));
    void run();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled, intervalMs]);

  return { ...state, reload: () => setNonce((n) => n + 1) };
}

/** Tracks connectivity so the UI can explain a queued capture. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = (): void => setOnline(true);
    const off = (): void => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** Persists a value in localStorage, surviving reloads. */
export function useLocalState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Storage full or blocked — the in-memory value still works.
      }
    },
    [key],
  );

  return [value, update];
}
