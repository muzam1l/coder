import './badge.css';
import type { ComponentChildren } from 'preact';

import { MoreList } from './menu';

/** From this many chips on, the first few show and +n opens every one. */
export const COLLAPSE_FROM = 5;
export const COLLAPSED = 3;

export function Badge({
  tone,
  title,
  children,
}: {
  tone?: 'acc' | 'ok' | 'warn' | 'solid';
  title?: string;
  children: ComponentChildren;
}) {
  return (
    <span class={tone ? `badge ${tone}` : 'badge'} title={title}>
      {children}
    </span>
  );
}

export function Chips({ values }: { values: Array<string | undefined> }) {
  const all = values.filter((value): value is string => Boolean(value));
  if (!all.length) return <span class="muted">None</span>;
  const chip = (value: string) => (
    <span key={value} class="chip">
      {value}
    </span>
  );
  const collapsed = all.length >= COLLAPSE_FROM;

  return (
    <span class="chips">
      {(collapsed ? all.slice(0, COLLAPSED) : all).map(chip)}
      {collapsed ? (
        <MoreList label={`+${all.length - COLLAPSED}`}>
          <span class="chips">{all.map(chip)}</span>
        </MoreList>
      ) : null}
    </span>
  );
}

/** A record's id: secondary, never a page's or row's label; the line it sits on clips it when space runs out. */
export function Id({ value, title }: { value: string; title?: string }) {
  return (
    <span class="id" title={title ?? value}>
      {value}
    </span>
  );
}
