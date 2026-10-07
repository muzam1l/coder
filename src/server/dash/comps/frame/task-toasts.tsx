'use client';

import '@/comps/ui/toast.css';

import { useEffect, useRef, useState } from 'preact/hooks';

import { serverEvents } from '@coder/client';
import type { TaskRow, TaskState } from '@coder/client/types';
import { client } from '@/utils/client';
import { Link } from '@wular/pnext/link';
import { usePathname, useRouter } from '@wular/pnext/navigation/client';
import { Status, STATUS_LABEL } from '@/app/dash/tasks/list/status';

type Watched = { title: string; status: TaskState; at: number };
type Live = Pick<TaskRow, 'status' | 'result' | 'error' | 'approval'>;
type Toast = { key: string; id?: string; title: string; status?: TaskState; line: string };

const WATCHED = 'coder:watched';
export const NOTIFY = 'coder:notify';
const TOAST = 'coder:toast';
const DONE = new Set<TaskState>(['completed', 'failed', 'cancelled']);
const SHOWN = new Set<TaskState>([...DONE, 'waiting']);
const KEEP = 20;
const STREAMS = 3;
const MAX = 3;
const TTL = 8000;
// Past any log line, so a stream sends status alone; log seqs are PostgreSQL integers.
const NO_LINES = 2 ** 31 - 1;

const read = (): Record<string, Watched> => {
  try {
    return JSON.parse(localStorage.getItem(WATCHED) ?? '{}') ?? {};
  } catch {
    return {};
  }
};

const save = (all: Record<string, Watched>) => {
  const kept = Object.entries(all)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, KEEP);
  localStorage.setItem(WATCHED, JSON.stringify(Object.fromEntries(kept)));
  dispatchEvent(new Event(WATCHED));
};

/** An error toast for an action whose page has no room for it. */
export const toastError = (title: string, line: string) =>
  dispatchEvent(new CustomEvent(TOAST, { detail: { title, line } }));

/** Remembers a task this browser started or opened, so its finish shows a toast on any page. */
export function watchTask(id: string, status: TaskState, title?: string) {
  const all = read();
  const entry = all[id];
  if (!entry && DONE.has(status)) return;
  if (entry?.status === status && (!title || entry.title === title)) return;
  all[id] = { title: title || entry?.title || id, status, at: entry?.at ?? Date.now() };
  save(all);
}

const openTask = (path: string) => /^\/dash\/tasks\/([^/]+)$/.exec(path)?.[1];

function lineOf(live: Live): string {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim().split('\n')[0]! : '');
  const approval = (live.approval ?? {}) as Record<string, unknown>;
  const result = typeof live.result === 'object' ? live.result?.output : live.result;
  if (live.status === 'waiting')
    return (
      text(approval.summary) ||
      text(approval.reason) ||
      text(approval.kind) ||
      'It is waiting for your approval.'
    );
  if (live.status === 'completed') return text(result) || 'It finished.';
  return text(live.error) || (live.status === 'failed' ? 'It failed.' : 'It was stopped.');
}

/** Follows one watched task's event stream for its status alone. */
function Follow({ id, onStatus }: { id: string; onStatus: (id: string, live: Live) => void }) {
  useEffect(() => {
    const abort = new AbortController();
    const follow = async () => {
      while (!abort.signal.aborted) {
        try {
          const response = await client.tasks.stream(id, NO_LINES, abort.signal);
          if (response.status === 404) {
            const all = read();
            delete all[id];
            return save(all);
          }
          if (!response.ok || !response.body) return;
          for await (const event of serverEvents(response.body)) {
            if (event.event === 'status') onStatus(id, JSON.parse(event.data));
            else if (event.event === 'end') return;
          }
        } catch {
          if (abort.signal.aborted) return;
        }
        await new Promise(done => setTimeout(done, 1000));
      }
    };
    void follow();
    return () => abort.abort();
  }, [id]);
  return null;
}

function Item({ toast, dismiss }: { toast: Toast; dismiss: (key: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => dismiss(toast.key), TTL);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div class={toast.id ? 'toast' : 'toast err'} onClick={() => dismiss(toast.key)}>
      <p class="toast-head">
        {toast.id ? (
          <Link class="cover" href="/dash/tasks/[id]" params={{ id: toast.id }}>
            {toast.title}
          </Link>
        ) : (
          <span class="cover">{toast.title}</span>
        )}
        {toast.status ? <Status status={toast.status} /> : null}
      </p>
      <p class="toast-line">{toast.line}</p>
    </div>
  );
}

/** Toasts at the bottom right when a watched task finishes or needs approval, except on its own page. */
export function TaskToasts() {
  const path = usePathname();
  const nav = useRouter();
  const [watched, setWatched] = useState<Record<string, Watched>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const open = useRef(openTask(path));
  open.current = openTask(path);

  useEffect(() => {
    const sync = () => setWatched(read());
    sync();
    addEventListener(WATCHED, sync);
    addEventListener('storage', sync);
    return () => {
      removeEventListener(WATCHED, sync);
      removeEventListener('storage', sync);
    };
  }, []);

  useEffect(() => {
    const onToast = (event: Event) => {
      const { title, line } = (event as CustomEvent<{ title: string; line: string }>).detail;
      setToasts(list => [{ key: `${TOAST}:${Date.now()}`, title, line }, ...list].slice(0, MAX));
    };
    addEventListener(TOAST, onToast);
    return () => removeEventListener(TOAST, onToast);
  }, []);

  useEffect(() => {
    if (!toasts.length) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setToasts([]);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [toasts.length]);

  const dismiss = (key: string) => setToasts(list => list.filter(toast => toast.key !== key));

  const onStatus = (id: string, live: Live) => {
    const seen = read()[id];
    if (!seen || seen.status === live.status) return;
    watchTask(id, live.status);
    if (!SHOWN.has(live.status) || open.current === id) return;
    const toast = {
      key: `${id}:${Date.now()}`,
      id,
      title: seen.title,
      status: live.status,
      line: lineOf(live),
    };
    setToasts(list => [toast, ...list].slice(0, MAX));
    if (
      localStorage.getItem(NOTIFY) !== '1' ||
      typeof Notification === 'undefined' ||
      Notification.permission !== 'granted'
    )
      return;
    const notice = new Notification(`${toast.title} (${STATUS_LABEL[toast.status]})`, {
      body: toast.line,
      tag: id,
    });
    notice.onclick = () => {
      focus();
      nav.push('/dash/tasks/[id]', { params: { id } });
    };
  };

  // Its own page follows an open task; the rest share a few streams, newest first.
  const follow = Object.entries(watched)
    .filter(([id, entry]) => !DONE.has(entry.status) && id !== open.current)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, STREAMS);

  return (
    <>
      {follow.map(([id]) => (
        <Follow key={id} id={id} onStatus={onStatus} />
      ))}
      <section class="toasts" aria-label="Task updates" aria-live="polite">
        {toasts.map(toast => (
          <Item key={toast.key} toast={toast} dismiss={dismiss} />
        ))}
      </section>
    </>
  );
}
