import './card.css';
import type { ComponentChildren } from 'preact';

import { Icon } from './icon';
import { iPlus } from './icons';

export function Card({
  title,
  count,
  actions,
  tone,
  children,
}: {
  title?: ComponentChildren;
  count?: number | string;
  actions?: ComponentChildren;
  tone?: 'accent' | 'danger';
  children: ComponentChildren;
}) {
  return (
    <section class={tone ? `card frame ${tone}` : 'card frame'}>
      {title ? (
        <div class="bar">
          <h2>
            {title}
            {count !== undefined ? <span class="n">{count}</span> : null}
          </h2>
          {actions ? <span class="bar-r">{actions}</span> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** A card that starts folded: its bar shows the title and a one-line note, and a click opens it. */
export function FoldCard({
  title,
  note,
  actions,
  open = 'Add',
  opened,
  children,
}: {
  title: ComponentChildren;
  note: ComponentChildren;
  actions?: ComponentChildren;
  /** The folded bar's button; Add shows a plus. */
  open?: string;
  /** Starts unfolded, as when there is nothing in the list under it yet. */
  opened?: boolean;
  children: ComponentChildren;
}) {
  return (
    <details class="card frame fold" open={opened}>
      <summary class="bar">
        <h2>{title}</h2>
        <span class="fold-note">{note}</span>
        {actions ? <span class="bar-r">{actions}</span> : null}
        <span class="btn outline sm fold-open" aria-hidden="true">
          {open === 'Add' ? <Icon d={iPlus} /> : null}
          {open}
        </span>
        <span class="btn ghost sm fold-close" aria-hidden="true">
          Close
        </span>
      </summary>
      {children}
    </details>
  );
}

export function Empty({ title, children }: { title: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <b>{title}</b>
      {children ? <span>{children}</span> : null}
    </div>
  );
}

/** The one loading state: a spinner and a short line; `inline` keeps it to one line. */
export function Loading({
  label,
  inline,
  dots,
  h,
}: {
  label: string;
  inline?: boolean;
  /** Three pulsing dots instead of the ring, for a quiet wait. */
  dots?: boolean;
  /** The height, in pixels, of what arrives in its place. */
  h?: number;
}) {
  const Tag = inline ? 'span' : 'div';
  return (
    <Tag
      class={inline ? 'loading inline' : 'loading'}
      role="status"
      style={h ? `--h:${h}px` : undefined}
    >
      <span>
        {dots ? (
          <i class="dots">
            <b />
            <b />
            <b />
          </i>
        ) : (
          <i class="spin" />
        )}
        {label}
      </span>
    </Tag>
  );
}
