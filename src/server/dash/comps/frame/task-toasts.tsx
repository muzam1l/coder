'use client';

import '@/comps/ui/toast.css';

import { useEffect, useRef, useState } from 'preact/hooks';

import { serverEvents } from '@coder/client';
import type { TaskEvent, TaskRow, TaskState } from '@coder/client/types';
import { client } from '@/utils/client';
import { Link } from '@wular/pnext/link';
import { usePathname, useRouter } from '@wular/pnext/navigation/client';
import { Status, STATUS_LABEL } from '@/app/dash/tasks/list/status';

type Watched = { title: string; status: TaskState; at: number };
type Live = Pick<TaskRow, 'status' | 'result' | 'error' | 'approval'>;
type Toast = { key: string; id?: string; title: string; status?: TaskState; line: string; err?: boolean };

const WATCHED = 'coder:watched';
export const NOTIFY = 'coder:notify';
const TOAST = 'coder:toast';
const DONE = new Set<TaskState>(['completed', 'failed', 'cancelled']);
const SHOWN = new Set<TaskState>([...DONE, 'waiting']);
const KEEP = 20;
const MAX = 3;
const TTL = 8000;
// The Web Lock that picks the one tab holding the events stream, and the channel it shares them on.
const EVENTS = 'coder:events';
const TASK = 'coder:task';
const REPLAY = 'coder:task-replay';
const RESET = 'coder:task-reset';
const RESYNC = 'coder:task-resync';
// A write that commits past the server's look-back still reaches shown pages within this, through a fresh read.
const RESYNC_MS = 60_000;
// Latest events a tab keeps, so a page that mounts later starts from them.
const LATEST = 200;

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

/** A toast for an action whose page has no room for its outcome. */
export const showToast = (title: string, line: string, err?: boolean) =>
  dispatchEvent(new CustomEvent(TOAST, { detail: { title, line, err } }));

export const toastError = (title: string, line: string) => showToast(title, line, true);

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

/** Hears every task change from this browser's one events stream; `reset` when some may have been missed, `resync` once a minute to read again. */
export function useTaskEvents(
  on: (event: TaskEvent) => void,
  reset?: () => void,
  resync?: () => void,
) {
  const handler = useRef({ on, reset, resync });
  handler.current = { on, reset, resync };
  useEffect(() => {
    const listener = (event: Event) => handler.current.on((event as CustomEvent<TaskEvent>).detail);
    const again = () => handler.current.reset?.();
    const read = () => handler.current.resync?.();
    addEventListener(TASK, listener);
    addEventListener(RESET, again);
    addEventListener(RESYNC, read);
    dispatchEvent(
      new CustomEvent(REPLAY, { detail: (event: TaskEvent) => handler.current.on(event) }),
    );
    return () => {
      removeEventListener(TASK, listener);
      removeEventListener(RESET, again);
      removeEventListener(RESYNC, read);
    };
  }, []);
}

type Message = { hello?: true; id?: string; event?: TaskEvent; reset?: true; resync?: true };

/** One events stream per browser: the tab holding the lock reads it, shares it on a channel, and a tab that takes over resumes from the last event id. */
function useEventsStream(ids: string[], leading: { current: boolean }) {
  const asked = useRef(ids);
  asked.current = ids;
  const current = useRef<{ key: string; abort: AbortController }>();
  const key = [...ids].sort().join(',');

  useEffect(() => {
    const latest = new Map<string, TaskEvent>();
    const deliver = (event: TaskEvent) => {
      latest.delete(event.id);
      latest.set(event.id, event);
      if (latest.size > LATEST) latest.delete(latest.keys().next().value!);
      dispatchEvent(new CustomEvent(TASK, { detail: event }));
    };
    const replay = (event: Event) => {
      for (const each of latest.values())
        (event as CustomEvent<(e: TaskEvent) => void>).detail(each);
    };
    addEventListener(REPLAY, replay);
    const channel =
      typeof BroadcastChannel !== 'undefined' && navigator.locks
        ? new BroadcastChannel(EVENTS)
        : undefined;
    const abort = new AbortController();
    let last: string | undefined;
    let wake = () => {};
    let soon: ReturnType<typeof setTimeout> | undefined;
    const receive = (message: Message) => {
      last = message.id ?? last;
      if (message.event) deliver(message.event);
      if (message.resync) dispatchEvent(new Event(RESYNC));
      if (!message.reset) return;
      latest.clear();
      dispatchEvent(new Event(RESET));
    };
    channel?.addEventListener('message', ({ data }: MessageEvent<Message>) => {
      if (!data.hello) return receive(data);
      // A tab that just loaded, maybe into another workspace: the next stream resumes for it too.
      soon ??= setTimeout(() => {
        soon = undefined;
        current.current?.abort.abort();
        wake();
      }, 300);
    });
    channel?.postMessage({ hello: true });

    const lead = async () => {
      leading.current = true;
      const resync = setInterval(() => {
        channel?.postMessage({ resync: true });
        receive({ resync: true });
      }, RESYNC_MS);
      try {
        await follow();
      } finally {
        clearInterval(resync);
      }
    };

    const follow = async () => {
      while (!abort.signal.aborted) {
        const once = new AbortController();
        const stop = () => once.abort();
        abort.signal.addEventListener('abort', stop);
        const ids = asked.current;
        current.current = { key: [...ids].sort().join(','), abort: once };
        let wait = 1000;
        try {
          const response = await client.tasks.events(ids, last, once.signal);
          // A server without the events stream: nothing to follow.
          if (response.status === 404) return void (leading.current = false);
          // Signed out: a tab that signs in again wakes the next try.
          if (!response.ok || !response.body)
            wait = [401, 403].includes(response.status) ? 60_000 : 5000;
          else
            for await (const { event, data, id } of serverEvents(response.body)) {
              // A stream replaced by the next one says nothing more.
              if (once.signal.aborted) break;
              const message: Message = {
                ...(id ? { id } : {}),
                ...(event === 'task' ? { event: JSON.parse(data) as TaskEvent } : {}),
                ...(event === 'reset' ? { reset: true as const } : {}),
              };
              channel?.postMessage(message);
              receive(message);
            }
        } catch {}
        abort.signal.removeEventListener('abort', stop);
        // A new task set opens the next stream at once.
        if (once.signal.aborted) continue;
        await new Promise<void>(done => {
          const timer = setTimeout(done, wait);
          wake = () => {
            clearTimeout(timer);
            done();
          };
        });
        wake = () => {};
      }
    };

    if (channel)
      void navigator.locks.request(EVENTS, { signal: abort.signal }, lead).catch(() => {});
    else void lead();
    return () => {
      abort.abort();
      wake();
      clearTimeout(soon);
      channel?.close();
      removeEventListener(REPLAY, replay);
    };
  }, []);

  useEffect(() => {
    if (current.current && current.current.key !== key) current.current.abort.abort();
  }, [key]);
}

function Item({ toast, dismiss }: { toast: Toast; dismiss: (key: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => dismiss(toast.key), TTL);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div class={toast.err ? 'toast err' : 'toast'} onClick={() => dismiss(toast.key)}>
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
  // Each tab's own last status per task, so every tab toasts a change once.
  const known = useRef<Record<string, TaskState>>({});
  const leading = useRef(false);

  useEffect(() => {
    const sync = () => {
      const all = read();
      for (const [id, entry] of Object.entries(all)) known.current[id] ??= entry.status;
      setWatched(all);
    };
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
      const detail = (event as CustomEvent<Omit<Toast, 'key'>>).detail;
      setToasts(list => [{ key: `${TOAST}:${Date.now()}`, ...detail }, ...list].slice(0, MAX));
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

  useTaskEvents(event => {
    const all = read();
    const seen = all[event.id];
    if (!seen) return;
    if (event.deleted) {
      delete all[event.id];
      return save(all);
    }
    const before = known.current[event.id] ?? seen.status;
    known.current[event.id] = event.status;
    if (before !== event.status)
      onStatus(
        event.id,
        { ...event, result: event.result ?? undefined, error: event.error ?? undefined },
        seen,
      );
  });

  const onStatus = (id: string, live: Live, seen: Watched) => {
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
      !leading.current ||
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

  useEventsStream(
    Object.entries(watched)
      .filter(([, entry]) => !DONE.has(entry.status))
      .map(([id]) => id),
    leading,
  );

  return (
    <section class="toasts" aria-label="Task updates" aria-live="polite">
      {toasts.map(toast => (
        <Item key={toast.key} toast={toast} dismiss={dismiss} />
      ))}
    </section>
  );
}
