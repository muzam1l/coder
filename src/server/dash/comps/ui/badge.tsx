import './badge.css';
import type { ComponentChildren, JSX } from 'preact';

import { MoreList } from './menu';

/** From this many chips on, the first few show and +n opens every one. */
export const COLLAPSE_FROM = 5;
export const COLLAPSED = 3;

/** A tag; with `onClick` a button, with `href` a link, `external` in a new tab. */
export function Badge({
  tone,
  title,
  onClick,
  href,
  external,
  class: cls,
  children,
}: {
  tone?: 'acc' | 'ok' | 'warn' | 'solid';
  title?: string;
  onClick?: () => void;
  href?: string;
  external?: boolean;
  /** The page's own classes. */
  class?: string;
  children: ComponentChildren;
}) {
  const className = ['badge', tone, cls].filter(Boolean).join(' ');

  if (href)
    return (
      <a
        class={className}
        href={href}
        title={title}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        {children}
      </a>
    );
  if (onClick)
    return (
      <button type="button" class={className} title={title} onClick={onClick}>
        {children}
      </button>
    );
  return (
    <span class={className} title={title}>
      {children}
    </span>
  );
}

/** A small tag in a row of them; with `onClick` a button, `aria-pressed` for a toggle. */
export function Chip({
  onClick,
  children,
  ...rest
}: Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'class' | 'onClick'> & {
  onClick?: () => void;
}) {
  return onClick ? (
    <button {...rest} type="button" class="chip" onClick={onClick}>
      {children}
    </button>
  ) : (
    <span class="chip">{children}</span>
  );
}

/** A row of chips; `values` shows text, fewer past `COLLAPSE_FROM`, or `children` holds ready ones. */
export function Chips({
  values,
  label,
  children,
}: {
  values?: Array<string | undefined>;
  /** Names the row as a group. */
  label?: string;
  children?: ComponentChildren;
}) {
  if (children)
    return (
      <span class="chips" role="group" aria-label={label}>
        {children}
      </span>
    );

  const all = (values ?? []).filter((value): value is string => Boolean(value));
  if (!all.length) return <span class="muted">None</span>;
  const chip = (value: string) => <Chip key={value}>{value}</Chip>;
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
