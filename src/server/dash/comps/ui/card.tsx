import './card.css';
import type { ComponentChildren } from 'preact';

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
