import './card.css';
import type { ComponentChildren } from 'preact';

import { Button } from './button';
import { iPlus } from './icons';

export function Card({
  id,
  title,
  count,
  actions,
  tone,
  children,
}: {
  id?: string;
  title?: ComponentChildren;
  count?: number | string;
  actions?: ComponentChildren;
  tone?: 'accent' | 'danger';
  children: ComponentChildren;
}) {
  return (
    <section id={id} class={tone ? `card frame ${tone}` : 'card frame'}>
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
        <Button
          as="span"
          variant="outline"
          size="sm"
          class="fold-open"
          leftIcon={open === 'Add' ? iPlus : undefined}
        >
          {open}
        </Button>
        <Button as="span" variant="ghost" size="sm" class="fold-close">
          Close
        </Button>
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
  late,
  h,
}: {
  label: string;
  inline?: boolean;
  /** Three pulsing dots instead of the ring, for a quiet wait. */
  dots?: boolean;
  /** Shows only after 300 ms, for a client load that a fast answer replaces unseen. */
  late?: boolean;
  /** The height, in pixels, of what arrives in its place. */
  h?: number;
}) {
  const Tag = inline ? 'span' : 'div';
  return (
    <Tag
      class={['loading', inline && 'inline', late && 'late'].filter(Boolean).join(' ')}
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
