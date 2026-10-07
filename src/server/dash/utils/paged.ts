import { useEffect, useRef, useState } from 'preact/hooks';

import type { Paged } from '@coder/client/types';

type Kept = { query: string; rows: unknown[]; next?: string; meta?: unknown };

const entry = (name: string) =>
  `${(history.state as { __pnextEntry?: string } | null)?.__pnextEntry ?? location.pathname}|${name}`;
const savedRows = (name: string): Kept | undefined => history.state?.coderPages?.[name];
const saveRows = (name: string, rows: Kept) =>
  history.replaceState(
    { ...history.state, coderPages: { ...history.state?.coderPages, [name]: rows } },
    '',
  );
const FRESH_MS = 60_000;

/** Passes `value` on once a loader shown since `since` has stayed its 300 ms; one that never showed holds nothing. */
export const held =
  (since: number) =>
  <T>(value: T) =>
    new Promise<T>(done => {
      const waited = performance.now() - since;
      setTimeout(done, waited > 150 ? 450 - waited : 0, value);
    });

const fromPage = (query: string, page: Paged<unknown>): Kept => ({
  query,
  rows: page.items,
  next: page.next,
  meta: page,
});

/** Cursor pages; the server renders the first, more load near the end, a new `query` starts over. */
export function usePaged<T>({
  name,
  query,
  first,
  initial,
  root,
  fetchPage,
}: {
  name: string;
  /** What the rows are filtered by. */
  query: string;
  /** The server's first page, and the query it answered. */
  first: Paged<T>;
  initial: string;
  /** A scrolling box, when the list scrolls inside one instead of the page. */
  root?: () => Element | null;
  /** For APIs with their own paging shape. */
  fetchPage: (cursor: string) => Promise<Paged<T>>;
}) {
  const firstPages = useRef(
    new Map<string, { page: Paged<unknown>; at: number }>([
      [initial, { page: first, at: Date.now() }],
    ]),
  );
  const [state, setState] = useState<Kept>(() => fromPage(initial, first));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sentinel = useRef<HTMLElement>(null);
  const live = useRef(state);
  live.current = state;
  const loading = useRef<string | undefined>(undefined);
  const failed = useRef<(() => void) | undefined>(undefined);

  const load = (cursor: string, forQuery: string, append: boolean) => {
    const key = `${forQuery}|${cursor}`;
    if (loading.current === key) return;
    loading.current = key;
    setError('');
    setBusy(true);
    const since = performance.now();
    const at = entry(name);
    const cached = append ? undefined : firstPages.current.get(forQuery);
    if (cached && Date.now() - cached.at < FRESH_MS) setState(fromPage(forQuery, cached.page));
    void fetchPage(cursor)
      .then(held(since))
      .then(page => {
        if (loading.current !== key) return;
        if (!append) firstPages.current.set(forQuery, { page, at: Date.now() });
        setError('');
        failed.current = undefined;
        setState(current => {
          const next =
            append && current.query === forQuery
              ? {
                  ...current,
                  rows: [...current.rows, ...page.items],
                  next: page.next,
                }
              : fromPage(forQuery, page);
          if (entry(name) === at) saveRows(name, next);
          return next;
        });
      })
      .catch(reason => {
        if (loading.current !== key) return;
        failed.current = () => load(cursor, forQuery, append);
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (loading.current !== key) return;
        loading.current = undefined;
        setBusy(false);
      });
  };

  useEffect(
    () => () => {
      loading.current = undefined;
    },
    [],
  );

  // A refresh hands the island a new first page.
  const seen = useRef(first);
  useEffect(() => {
    if (seen.current === first) return;
    seen.current = first;
    firstPages.current.set(initial, { page: first, at: Date.now() });
    setState(fromPage(initial, first));
  }, [first]);

  // A new query drops any load for another; back to this entry: the rows it had; else its first page.
  useEffect(() => {
    loading.current = undefined;
    failed.current = undefined;
    setError('');
    setBusy(false);
    const saved = savedRows(name);
    if (saved && saved.query === query && saved.rows.length > live.current.rows.length) {
      setState(saved);
      return;
    }
    if (query !== live.current.query) load('', query, false);
  }, [query]);

  useEffect(() => {
    const mark = sentinel.current;
    if (!mark || !state.next || error) return;
    const observer = new IntersectionObserver(
      ([seen]) => {
        if (seen?.isIntersecting && live.current.next && live.current.query === query)
          load(live.current.next, query, true);
      },
      { root: root?.() ?? null, rootMargin: '0px 0px 300px 0px' },
    );
    observer.observe(mark);
    return () => observer.disconnect();
  }, [state.next, state.rows.length, query, error]);

  return {
    rows: state.rows as T[],
    /** The first page as the server sent it, for totals that ride along. */
    meta: state.meta as Paged<T> & Record<string, unknown>,
    more: Boolean(state.next),
    busy,
    error,
    stale: busy && state.query !== query,
    sentinel,
    retry: () => {
      setError('');
      failed.current?.();
    },
  };
}

/** Filters live in the address bar, so a reload or a shared link shows the same list. */
export function writeQuery(values: Record<string, string>) {
  const url = new URL(location.href);
  for (const [key, value] of Object.entries(values))
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  history.replaceState(history.state, '', url);
}

export function readQuery(keys: string[]): Record<string, string> {
  const params = new URLSearchParams(location.search);
  return Object.fromEntries(keys.map(key => [key, params.get(key) ?? '']));
}

/** Rows a list loads per page; more load as it scrolls. */
export const LIST_PAGE = 20;
