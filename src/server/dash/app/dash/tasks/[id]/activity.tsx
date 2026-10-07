'use client';

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'preact/hooks';
import {
  Virtualizer,
  observeWindowOffset,
  observeWindowRect,
  windowScroll,
} from '@tanstack/virtual-core';

import type { TaskDisplayRow } from '@coder/core/task/log-view';
import {
  iActivity,
  iAlert,
  iChart,
  iCheck,
  iDown,
  iKey,
  iMessage,
  iSpark,
  iSteer,
  iTerminal,
  iX,
} from '@/comps/ui/icons';
import { Icon } from '@/comps/ui/icon';
import { formatDuration, formatTime } from '@/utils/format';

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
  Boolean(row.detail) || row.title.length > 120 || row.title.includes('\n');

const atEnd = () => innerHeight + scrollY >= document.documentElement.scrollHeight - 48;

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

function Row({
  row,
  tz,
  open,
  onToggle,
}: {
  row: TaskDisplayRow;
  tz: string;
  open: boolean;
  onToggle: () => void;
}) {
  const title = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    if (title.current) setClipped(title.current.scrollWidth > title.current.clientWidth);
  }, [row.title]);
  const fold = open || clipped || foldable(row);
  const failed = row.tone === 'error';
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
  const Tag = fold ? 'button' : 'div';

  return (
    <Tag
      type={fold ? 'button' : undefined}
      class={`act ${row.kind}${row.tone ? ` ${row.tone}` : ''}${row.separated ? ' sep' : ''}${open ? ' open' : ''}`}
      aria-expanded={fold ? open : undefined}
      onClick={fold ? onToggle : undefined}
    >
      <time>{formatTime(row.at, tz)}</time>
      <Icon d={row.kind === 'tool-result' && failed ? iX : ICONS[row.kind]} />
      <span class="act-text">
        <span class="act-title" ref={title}>
          {row.title}
        </span>
        {extra ? <span class="act-detail">{extra}</span> : null}
        {row.detail ? <span class="act-detail">{row.detail}</span> : null}
      </span>
      {fold ? <Icon d={iDown} class="act-chev" /> : null}
    </Tag>
  );
}

/** What the task did, as the CLI's watch shows it: one line per event, long ones folded, following the end while you are there. */
export function Activity({
  rows,
  live,
  tz,
}: {
  rows: TaskDisplayRow[];
  live: boolean;
  tz: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [follow, setFollow] = useState(live);
  const virtual = useWindowVirtualizer(rows.length, list);

  useEffect(() => {
    const onScroll = () => setFollow(atEnd());
    addEventListener('scroll', onScroll, { passive: true });
    return () => removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    if (follow) scrollTo({ top: document.documentElement.scrollHeight });
  }, [rows.length]);

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
              class="act-slot"
              data-index={item.index}
              ref={virtual.measureElement}
              style={`transform:translateY(${item.start - virtual.options.scrollMargin}px)`}
            >
              <Row
                row={row}
                tz={tz}
                open={open.has(row.seq)}
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
      {follow ? null : (
        <button
          type="button"
          class="jump"
          onClick={() => {
            setFollow(true);
            scrollTo({ top: document.documentElement.scrollHeight });
          }}
        >
          Jump to latest
        </button>
      )}
    </>
  );
}
