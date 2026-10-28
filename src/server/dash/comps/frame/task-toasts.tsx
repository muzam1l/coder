'use client';

import './task-toasts.css';

import { useEffect, useRef, useState } from 'preact/hooks';

import { serverEvents } from '@coder/client/http';
import type {
  RunnersEvent,
  TaskCountEvent,
  TaskEvent,
  TaskRow,
  TaskState,
} from '@coder/client/types';
import { client, presence } from '@/utils/client';
import { Link } from '@wular/pnext/link';
import { usePathname, useRouter } from '@wular/pnext/navigation/client';
import { Status, STATUS_LABEL } from '@/app/dash/[org]/tasks/list/status';
import { useOrg } from '@/comps/nav/org';
import { IconButton } from '@/comps/ui/button';
import { iX } from '@/comps/ui/icons';

type Watched = { title: string; status: TaskState; at: number; org: string };
type Live = Pick<TaskRow, 'status' | 'result' | 'error' | 'approval'>;
type Toast = {
  key: string;
  id?: string;
  title: string;
  status?: TaskState;
  line: string;
  tone?: Tone;
};
type Tone = 'success' | 'warning' | 'error';

const WATCHED = 'coder:watched';
export const NOTIFY = 'coder:notify';
const TOAST = 'coder:toast';
const DONE = new Set<TaskState>(['completed', 'failed', 'cancelled']);
const SHOWN = new Set<TaskState>([...DONE, 'waiting']);
const KEEP = 20;
const MAX = 3;
const TTL = 8000;
// The Web Lock that picks the one tab polling the events, and the channel it shares them on.
const EVENTS = 'coder:events';
const TASK = 'coder:task';
const REPLAY = 'coder:task-replay';
const RESET = 'coder:task-reset';
const RESYNC = 'coder:task-resync';
const COUNTS = 'coder:task-counts';
const COUNTS_REPLAY = 'coder:task-counts-replay';
const RUNNERS = 'coder:runners';
// A write that commits past the server's look-back still reaches shown pages within this, through a fresh read.
const RESYNC_MS = 60_000;
// Latest events a tab keeps, so a page that mounts later starts from them.
const LATEST = 200;
const POLL_MS = 5000;
const NOTIFY_POLL_MS = 15_000;

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
export const showToast = (title: string, line: string, tone?: Tone) =>
  dispatchEvent(new CustomEvent(TOAST, { detail: { title, line, tone } }));

export const toastError = (title: string, line: string) => showToast(title, line, 'error');

/** Remembers a task this browser started or opened, so its finish shows a toast on any page of its organization. */
export function watchTask(id: string, status: TaskState, title?: string) {
  const all = read();
  const entry = all[id];
  if (!entry && DONE.has(status)) return;
  if (entry?.status === status && (!title || entry.title === title)) return;
  all[id] = {
    title: title || entry?.title || id,
    status,
    at: entry?.at ?? Date.now(),
    org: entry?.org ?? location.pathname.split('/')[2]!,
  };
  save(all);
}

const openTask = (path: string) => /^\/dash\/[^/]+\/tasks\/([^/]+)$/.exec(path)?.[1];

function lineOf(live: Live): string {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim().split('\n')[0]! : '');
  const approval = (live.approval ?? {}) as Record<string, unknown>;
  const result = typeof live.result === 'object' ? live.result?.output : live.result;
  if (live.status === 'waiting') return text(approval.reason) || 'It is waiting for your approval.';
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

type Message = {
  hello?: true;
  id?: string;
  event?: TaskEvent;
  counts?: TaskCountEvent;
  runners?: RunnersEvent;
  reset?: true;
  resync?: true;
};

/** One events poll per browser and organization: the tab holding the lock polls, shares the events on a channel, and a tab that takes over resumes from the last event id. */
function useEventsStream(ids: string[], leading: { current: boolean }, org: string) {
  const asked = useRef(ids);
  asked.current = ids;
  const current = useRef<{ key: string; abort: AbortController }>();
  const sync = useRef(() => {});
  const key = [...ids].sort().join(',');

  useEffect(() => {
    const latest = new Map<string, TaskEvent>();
    const deliver = (event: TaskEvent) => {
      // Each poll repeats what changed lately; pages hear a change once.
      if (JSON.stringify(latest.get(event.id)) === JSON.stringify(event)) return;
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
    let counts: TaskCountEvent | undefined;
    let runners = '';
    const replayCounts = (event: Event) =>
      counts && (event as CustomEvent<(counts: TaskCountEvent) => void>).detail(counts);
    addEventListener(COUNTS_REPLAY, replayCounts);
    const channel =
      typeof BroadcastChannel !== 'undefined' && navigator.locks
        ? new BroadcastChannel(`${EVENTS}:${org}`)
        : undefined;
    const abort = new AbortController();
    let last: string | undefined;
    let wake = () => {};
    let soon: ReturnType<typeof setTimeout> | undefined;
    const receive = (message: Message) => {
      last = message.id ?? last;
      if (message.event) deliver(message.event);
      if (message.counts) {
        counts = message.counts;
        dispatchEvent(new CustomEvent(COUNTS, { detail: counts }));
      }
      if (message.runners && JSON.stringify(message.runners) !== runners) {
        runners = JSON.stringify(message.runners);
        dispatchEvent(new CustomEvent(RUNNERS, { detail: message.runners }));
      }
      if (message.resync) dispatchEvent(new Event(RESYNC));
      if (!message.reset) return;
      latest.clear();
      dispatchEvent(new Event(RESET));
    };
    channel?.addEventListener('message', ({ data }: MessageEvent<Message>) => {
      if (!data.hello) return receive(data);
      // A tab someone came back to takes the poll from one that only notifies.
      if (!present && leading.current) return requeue();
      // A tab that just loaded: the next poll goes now, for it too.
      soon ??= setTimeout(() => {
        soon = undefined;
        current.current?.abort.abort();
        wake();
      }, 300);
    });

    const lead = async (signal: AbortSignal) => {
      leading.current = true;
      const resync = setInterval(() => {
        if (!present) return;
        channel?.postMessage({ resync: true });
        receive({ resync: true });
      }, RESYNC_MS);
      try {
        await follow(signal);
      } finally {
        clearInterval(resync);
        leading.current = false;
      }
    };

    const follow = async (signal: AbortSignal) => {
      while (!signal.aborted) {
        const once = new AbortController();
        const stop = () => once.abort();
        signal.addEventListener('abort', stop);
        const ids = asked.current;
        current.current = { key: [...ids].sort().join(','), abort: once };
        let wait = present ? POLL_MS : NOTIFY_POLL_MS;
        try {
          const response = await client.tasks.events(ids, last, once.signal);
          // A server without the events stream: nothing to follow.
          if (response.status === 404) return void (leading.current = false);
          // Signed out: a tab that signs in again wakes the next try.
          if ([401, 403].includes(response.status)) wait = 60_000;
          else if (response.ok && response.body)
            for await (const { event, data, id } of serverEvents(response.body)) {
              // A poll replaced by the next one says nothing more.
              if (once.signal.aborted) break;
              const message: Message = {
                ...(id ? { id } : {}),
                ...(event === 'task' ? { event: JSON.parse(data) as TaskEvent } : {}),
                ...(event === 'counts' ? { counts: JSON.parse(data) as TaskCountEvent } : {}),
                ...(event === 'runners' ? { runners: JSON.parse(data) as RunnersEvent } : {}),
                ...(event === 'reset' ? { reset: true as const } : {}),
              };
              channel?.postMessage(message);
              receive(message);
            }
        } catch (reason) {
          if (!once.signal.aborted) console.error('coder dashboard: events', reason);
        }
        signal.removeEventListener('abort', stop);
        // A new task set polls again at once.
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

    // A tab nobody is at polls nothing, unless it notifies of a watched task still running.
    let present: boolean | undefined;
    let turn: AbortController | undefined;
    const wanted = () =>
      present ||
      (asked.current.length > 0 &&
        localStorage.getItem(NOTIFY) === '1' &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted');
    sync.current = () => {
      if (!wanted()) {
        turn?.abort();
        turn = undefined;
        return wake();
      }
      if (turn) return;
      turn = new AbortController();
      const signal = AbortSignal.any([abort.signal, turn.signal]);
      if (channel)
        void navigator.locks
          .request(`${EVENTS}:${org}`, { signal }, () => lead(signal))
          .catch(reason => {
            if (!signal.aborted) console.error('coder dashboard: events', reason);
          });
      else void lead(signal);
    };
    const requeue = () => {
      turn?.abort();
      turn = undefined;
      wake();
      sync.current();
    };
    const leave = presence(state => {
      const now = state !== 'absent';
      if (now === present) return;
      present = now;
      if (now) {
        wake();
        channel?.postMessage({ hello: true });
      }
      // With no tab to take over, the poll in flight finishes.
      if (!now && leading.current && channel) requeue();
      else sync.current();
    });
    return () => {
      abort.abort();
      wake();
      clearTimeout(soon);
      channel?.close();
      leave();
      removeEventListener(REPLAY, replay);
      removeEventListener(COUNTS_REPLAY, replayCounts);
    };
  }, []);

  useEffect(() => {
    if (current.current && current.current.key !== key) current.current.abort.abort();
    sync.current();
  }, [key]);
}

/** Hears the runners this person sees whenever one is added, changed, removed, or goes on or offline. */
export function useRunnerEvents(on: (event: RunnersEvent) => void) {
  const handler = useRef(on);
  handler.current = on;
  useEffect(() => {
    const listener = (event: Event) => handler.current((event as CustomEvent<RunnersEvent>).detail);
    addEventListener(RUNNERS, listener);
    return () => removeEventListener(RUNNERS, listener);
  }, []);
}

/** The workspace's active tasks, as the events stream counts them. */
export function ActiveCount() {
  const [active, setActive] = useState<number>();

  useEffect(() => {
    const on = (event: Event) => setActive((event as CustomEvent<TaskCountEvent>).detail.active);
    addEventListener(COUNTS, on);
    dispatchEvent(
      new CustomEvent(COUNTS_REPLAY, {
        detail: (counts: TaskCountEvent) => setActive(counts.active),
      }),
    );
    return () => removeEventListener(COUNTS, on);
  }, []);

  return active ? (
    <span class="n" title={`${active} active`}>
      {active}
    </span>
  ) : null;
}

function Item({
  toast,
  paused,
  dismiss,
}: {
  toast: Toast;
  paused: boolean;
  dismiss: (key: string) => void;
}) {
  const org = useOrg();
  // Paused, it keeps the time it has left.
  const left = useRef(TTL);
  useEffect(() => {
    if (paused) return;
    const started = Date.now();
    const timer = setTimeout(() => dismiss(toast.key), left.current);
    return () => {
      clearTimeout(timer);
      left.current -= Date.now() - started;
    };
  }, [paused]);
  return (
    <div class={toast.tone ? `toast ${toast.tone}` : 'toast'}>
      <p class="toast-head">
        {toast.id ? (
          <Link
            class="toast-title"
            href="/dash/[org]/tasks/[id]"
            params={{ org, id: toast.id }}
            onClick={() => dismiss(toast.key)}
          >
            {toast.title}
          </Link>
        ) : (
          <span class="toast-title">{toast.title}</span>
        )}
        {toast.status ? <Status status={toast.status} /> : null}
        <IconButton icon={iX} label="Dismiss" onClick={() => dismiss(toast.key)} />
      </p>
      <p class="toast-line">{toast.line}</p>
    </div>
  );
}

/** Toasts at the bottom right when a watched task finishes or needs approval, except on its own page. */
export function TaskToasts() {
  const org = useOrg();
  const path = usePathname();
  const nav = useRouter();
  const [watched, setWatched] = useState<Record<string, Watched>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Every toast waits while the pointer or focus is on the stack, or the window is in the background.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [away, setAway] = useState(false);
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

  // The top layer keeps toasts above an open modal; reopening raises them over a newer one.
  const stack = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = stack.current!;
    if (el.matches(':popover-open')) el.hidePopover();
    if (toasts.length) el.showPopover();
  }, [toasts[0]?.key]);

  const dismiss = (key: string) => setToasts(list => list.filter(toast => toast.key !== key));

  useTaskEvents(event => {
    const seen = watched[event.id];
    if (seen?.org !== org) return;
    if (event.deleted) {
      const all = read();
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
      nav.push('/dash/[org]/tasks/[id]', { params: { org, id } });
    };
  };

  useEventsStream(
    Object.entries(watched)
      .filter(([, entry]) => entry.org === org && !DONE.has(entry.status))
      .map(([id]) => id),
    leading,
    org,
  );

  useEffect(() => {
    const leave = () => setAway(true);
    const back = () => setAway(false);
    addEventListener('blur', leave);
    addEventListener('focus', back);
    return () => {
      removeEventListener('blur', leave);
      removeEventListener('focus', back);
    };
  }, []);

  return (
    <section
      ref={stack}
      class="toasts"
      popover="manual"
      aria-label="Task updates"
      aria-live="polite"
      onPointerOver={() => setHovered(true)}
      onPointerOut={event =>
        setHovered(Boolean(stack.current?.contains(event.relatedTarget as Node | null)))
      }
      onFocusIn={() => setFocused(true)}
      onFocusOut={event =>
        setFocused(Boolean(stack.current?.contains(event.relatedTarget as Node | null)))
      }
    >
      {toasts.map(toast => (
        <Item key={toast.key} toast={toast} paused={hovered || focused || away} dismiss={dismiss} />
      ))}
    </section>
  );
}
