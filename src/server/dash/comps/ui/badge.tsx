import './badge.css';
import type { ComponentChildren } from 'preact';

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
  const shown = values.filter((value): value is string => Boolean(value));
  if (!shown.length) return <span class="muted">None</span>;
  return (
    <span class="chips">
      {shown.map(value => (
        <span key={value} class="chip">
          {value}
        </span>
      ))}
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
