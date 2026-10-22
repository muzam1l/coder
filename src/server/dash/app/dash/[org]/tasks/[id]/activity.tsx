'use client';

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'preact/hooks';
import { useFollowEnd } from '@/utils/follow';
import {
  Virtualizer,
  observeWindowOffset,
  observeWindowRect,
  windowScroll,
} from '@tanstack/virtual-core';

import type { TaskDisplayRow } from '@coder/core/task/view';
import {
  iActivity,
  iAlert,
  iChart,
  iCheck,
  iDown,
  iKey,
  iMessage,
  iRight,
  iSpark,
  iSteer,
  iTerminal,
  iX,
} from '@/comps/ui/icons';
import { Icon } from '@/comps/ui/icon';
import { Loading } from '@/comps/ui/card';
import { ago, formatDuration, formatTime } from '@/utils/format';
import { usePoll } from '@/utils/client';

const ICONS: Record<TaskDisplayRow['kind'], string> = {
  assistant: iMessage,
  tool: iTerminal,
  'tool-result': iCheck,
  approval: iKey,
  status: iActivity,
  error: iAlert,
  line: iActivity,
  reasoning: iSpark,
  steer: iSteer,
  usage: iChart,
};

/** Rows long enough to fold to one line. */
const foldable = (row: TaskDisplayRow) =>
  Boolean(row.detail || row.result?.detail) || row.title.length > 120 || row.title.includes('\n');

/** The list scrolls with the page; only rows near the viewport are in the DOM. */
function useWindowVirtualizer(count: number, list: { current: HTMLElement | null }) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const options = {
    count,
    estimateSize: () => 30,
    overscan: 16,
    getScrollElement: () => window,
    observeElementRect: observeWindowRect,
    observeElementOffset: observeWindowOffset,
    scrollToFn: windowScroll,
    scrollMargin: list.current ? list.current.getBoundingClientRect().top + scrollY : 0,
    onChange: () => rerender(0),
  };
  const [virtual] = useState(() => new Virtualizer<Window, HTMLElement>(options));
  virtual.setOptions(options);
  useLayoutEffect(() => virtual._didMount(), []);
  useLayoutEffect(() => virtual._willUpdate());
  return virtual;
}

/** Renders again every second while `on`. */
function useTick(on: boolean) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  usePoll(on ? async () => tick(0) : undefined, 1000);
}

/** Whether a call or approval still waits; calls the agent has moved on from without a result do not. */
function runningIn(rows: TaskDisplayRow[], live: boolean) {
  const settled = rows.findLastIndex(row => row.kind === 'assistant' || row.kind === 'reasoning');
  return (row: TaskDisplayRow, index: number) =>
    live && !row.result && (row.state !== undefined || (row.kind === 'tool' && index > settled));
}

/** A call's or approval's outcome on the right: a spinner and the time so far, then ✓ or ✗ and how long it took. */
function CallState({ row, running }: { row: TaskDisplayRow; running: boolean }) {
  useTick(running);
  const result = row.result;
  const took = running ? Math.max(0, Date.now() - row.at) : result?.durationMs;
  const text = [
    row.state,
    result && !result.ok && result.exitCode !== undefined ? `exit ${result.exitCode}` : '',
    took ? formatDuration(took) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <span class={`act-state${result && !result.ok ? ' bad' : ''}`}>
      {running ? <i class="spin" /> : result ? <Icon d={result.ok ? iCheck : iX} /> : null}
      {text}
    </span>
  );
}

function Row({
  row,
  tz,
  open,
  running,
  onToggle,
}: {
  row: TaskDisplayRow;
  tz: string;
  open: boolean;
  running: boolean;
  onToggle: () => void;
}) {
  const title = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    if (title.current) setClipped(title.current.scrollWidth > title.current.clientWidth);
  }, [row.title]);
  const fold = open || clipped || foldable(row);
  const failed = row.tone === 'error';
  const timed = row.kind === 'tool' || row.state !== undefined;
  const extra =
    row.kind === 'tool-result'
      ? [
          row.tool,
          row.exitCode !== undefined ? `exit ${row.exitCode}` : undefined,
          row.durationMs ? formatDuration(row.durationMs) : undefined,
        ]
          .filter(Boolean)
          .join(' · ')
      : row.kind === 'reasoning' && row.durationMs
        ? formatDuration(row.durationMs)
        : '';
  return (
    <div
      class={`act ${row.kind}${row.tone ? ` ${row.tone}` : ''}${timed ? ' timed' : ''}${open ? ' open' : ''}${fold ? ' fold' : ''}`}
      {...(fold
        ? {
            role: 'button',
            tabIndex: 0,
            'aria-expanded': open,
            // Selecting text in a row does not fold it.
            onClick: () => getSelection()?.isCollapsed !== false && onToggle(),
            onKeyDown: (event: KeyboardEvent) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onToggle();
            },
          }
        : {})}
    >
      <time>{formatTime(row.at, tz)}</time>
      <Icon d={row.kind === 'tool-result' && failed ? iX : ICONS[row.kind]} />
      <span class="act-text">
        <span class="act-title" ref={title}>
          {row.title}
        </span>
        {extra ? <span class="act-detail">{extra}</span> : null}
        {row.detail && (open || !row.state) ? <span class="act-detail">{row.detail}</span> : null}
        {open && row.result?.detail ? <span class="act-detail">{row.result.detail}</span> : null}
      </span>
      {timed ? <CallState row={row} running={running} /> : null}
      {fold ? <Icon d={iDown} class="act-chev" /> : null}
    </div>
  );
}

/** What the task did, as the CLI's watch shows it: one line per event, long ones folded, following the end while you are there; `at` opens it at a row's seq or the end. */
export function Activity({
  rows,
  live,
  tz,
  at,
}: {
  rows: TaskDisplayRow[];
  live: boolean;
  tz: string;
  at?: number | 'end';
}) {
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(() => new Set(typeof at === 'number' ? [at] : []));
  const { following, follow } = useFollowEnd(at === undefined ? live : at === 'end');
  const virtual = useWindowVirtualizer(rows.length, list);
  const running = runningIn(rows, live);

  useEffect(() => {
    const index = rows.findIndex(row => row.seq === at);
    if (index < 0 || !list.current) return;

    // The first render had no list to measure its offset from.
    const scrollMargin = list.current.getBoundingClientRect().top + scrollY;
    virtual.setOptions({ ...virtual.options, scrollMargin });
    scrollTo({ top: virtual.getOffsetForIndex(index, 'center')?.[0] ?? 0 });
    // Rows measure as they render, so hold the row until it settles: centred between the sticky head
    // and the reply box, or its top when taller than that. Scrolling yourself lets go.
    let frames = 60;
    let still = 0;
    let frame = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      for (const type of ['wheel', 'touchstart', 'keydown']) removeEventListener(type, stop);
    };
    const align = () => {
      const slot = list.current?.querySelector<HTMLElement>('.act-slot.at');
      if (slot) {
        const top = parseFloat(getComputedStyle(slot).scrollMarginTop);
        const bottom =
          document.querySelector('form.reply')?.getBoundingClientRect().top ?? innerHeight;
        const box = slot.getBoundingClientRect();
        const delta = box.top - (box.height > bottom - top ? top : (top + bottom - box.height) / 2);
        if (Math.abs(delta) < 1) still++;
        else scrollBy(0, delta);
      }
      if (still < 3 && --frames) frame = requestAnimationFrame(align);
      else stop();
    };
    for (const type of ['wheel', 'touchstart', 'keydown'])
      addEventListener(type, stop, { passive: true });
    frame = requestAnimationFrame(align);
    return stop;
  }, []);

  if (!rows.length)
    return (
      <p class="act-empty muted">
        {live ? 'Nothing yet. Events appear here as the task runs.' : 'No activity recorded.'}
      </p>
    );

  return (
    <>
      <div
        class="act-list"
        ref={list}
        style={`height:${virtual.getTotalSize()}px`}
        role="log"
        aria-live="off"
      >
        {virtual.getVirtualItems().map(item => {
          const row = rows[item.index]!;
          return (
            <div
              key={row.seq}
              class={row.seq === at ? 'act-slot at' : 'act-slot'}
              data-index={item.index}
              ref={virtual.measureElement}
              style={`transform:translateY(${item.start - virtual.options.scrollMargin}px)`}
            >
              <Row
                row={row}
                tz={tz}
                open={open.has(row.seq)}
                running={running(row, item.index)}
                onToggle={() =>
                  setOpen(value => {
                    const next = new Set(value);
                    if (!next.delete(row.seq)) next.add(row.seq);
                    return next;
                  })
                }
              />
            </div>
          );
        })}
      </div>
      {following ? null : (
        <button type="button" class="jump" onClick={follow}>
          Jump to latest
        </button>
      )}
    </>
  );
}

/** The kinds a run's preview shows as steps. */
const STEPS = new Set<TaskDisplayRow['kind']>(['tool', 'tool-result', 'approval']);

/** A run's counts on one line: calls, approvals, failures, reasoning time, and how long it has run. */
export function runSummary(rows: TaskDisplayRow[], elapsed?: number) {
  const calls = rows.filter(row => row.kind === 'tool').length;
  const approved = rows.filter(row => row.kind === 'approval' && row.result?.ok).length;
  const denied = rows.filter(row => row.kind === 'approval' && row.result?.ok === false).length;
  const failed = rows.filter(row =>
    row.kind === 'tool'
      ? row.result?.ok === false
      : row.kind === 'tool-result' && row.tone === 'error',
  ).length;
  const reasoning = rows.reduce(
    (sum, row) => sum + (row.kind === 'reasoning' ? (row.durationMs ?? 0) : 0),
    0,
  );

  return [
    calls ? `${calls} tool ${calls === 1 ? 'call' : 'calls'}` : '',
    approved ? `${approved} approved` : '',
    denied ? `${denied} denied` : '',
    failed ? `${failed} failed` : '',
    reasoning ? `reasoning ${formatDuration(reasoning)}` : '',
    elapsed === undefined ? '' : formatDuration(elapsed),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** One step in the preview, as an Activity row: its outcome, its title, and when it ended. */
function Step({
  row,
  running,
  onOpen,
}: {
  row: TaskDisplayRow;
  running: boolean;
  onOpen: () => void;
}) {
  const waiting = running && row.state === 'waiting';
  const failed = row.result ? !row.result.ok : row.tone === 'error';
  const icon = waiting
    ? iKey
    : row.result
      ? row.result.ok
        ? iCheck
        : iX
      : failed
        ? iX
        : ICONS[row.kind];

  return (
    <button
      type="button"
      class={`act step ${row.kind}${waiting || row.tone === 'warning' ? ' warning' : failed ? ' error' : ''}`}
      onClick={onOpen}
    >
      {running && !waiting ? <i class="spin" /> : <Icon d={icon} />}
      <span class="act-text" key={row.seq}>
        <span class="act-title">{waiting ? 'Waiting for your approval' : row.title}</span>
        {waiting ? <span class="act-detail">{row.title}</span> : null}
      </span>
      <span class="act-state">
        {running && !waiting
          ? (row.state ?? 'running')
          : ago(row.at + (row.result?.durationMs ?? 0))}
      </span>
      <Icon d={iRight} class="act-chev" />
    </button>
  );
}

/** A running task's summary and last two steps, a pending approval first; a step opens Activity at its row, the summary at the end. */
export function RunPreview({
  rows,
  startedAt,
  onOpen,
}: {
  rows: TaskDisplayRow[];
  startedAt?: number;
  onOpen: (at: number | 'end') => void;
}) {
  useTick(true);
  const running = runningIn(rows, true);
  // Before its first step the run shows its starting lines, a skipped engine or a connection to reconnect, in the same two lines.
  const first = rows.findIndex(row => STEPS.has(row.kind));
  const starting = (first < 0 ? rows : rows.slice(0, first)).filter(
    row => row.kind === 'status' || row.kind === 'error',
  );
  const steps = [
    ...starting.map(row => ({ row, running: false })),
    ...rows.flatMap((row, index) =>
      STEPS.has(row.kind) ? [{ row, running: running(row, index) }] : [],
    ),
  ];
  const waiting = steps.filter(step => step.running && step.row.state === 'waiting');
  const rest = steps.filter(step => !waiting.includes(step));
  const shown = [...waiting, ...rest.slice(Math.max(0, rest.length - 2 + waiting.length))].slice(
    0,
    2,
  );

  return (
    <div class="body run">
      <button type="button" class="act run-sum" onClick={() => onOpen('end')}>
        {runSummary(rows, startedAt === undefined ? undefined : Date.now() - startedAt)}
        <Icon d={iRight} class="act-chev" />
      </button>
      <div class={steps.length > shown.length ? 'run-steps earlier' : 'run-steps'}>
        {/* Keyed by line, so a new step replaces each line's text in place instead of moving lines. */}
        {shown.map((step, line) => (
          <Step key={line} {...step} onOpen={() => onOpen(step.row.seq)} />
        ))}
      </div>
      <Loading inline dots label="The result appears here when the task finishes." />
    </div>
  );
}
