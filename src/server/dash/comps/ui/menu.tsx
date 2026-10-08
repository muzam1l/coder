'use client';

import './menu.css';

import type { ComponentChildren } from 'preact';
import { useId, useRef } from 'preact/hooks';

import { iCheck } from './icons';
import { Icon } from './icon';

/** A button and its popover panel, placed at the button; picking an item, an outside click or Escape closes it. */
export function Menu({
  summary,
  summaryClass,
  label,
  tip,
  align = 'right',
  wide,
  class: cls,
  children,
}: {
  summary: ComponentChildren;
  summaryClass?: string;
  label?: string;
  /** A styled tooltip in place of the native title, where the layout shows one. */
  tip?: string;
  align?: 'right' | 'up' | 'left';
  wide?: boolean;
  class?: string;
  children: ComponentChildren;
}) {
  const id = useId();
  return (
    <span class={`menu ${align}${cls ? ` ${cls}` : ''}`}>
      <button
        popovertarget={id}
        type="button"
        class={summaryClass}
        aria-label={label}
        title={tip ? undefined : label}
        data-tip={tip}
      >
        {summary}
      </button>
      <div
        id={id}
        class={wide ? 'pop wide' : 'pop'}
        popover="auto"
        onBeforeToggle={event => {
          // A tall menu scrolls within the room on its side of the button instead of leaving the viewport.
          if ((event as ToggleEvent).newState !== 'open') return;
          const pop = event.currentTarget as HTMLElement;
          const box = pop.parentElement?.querySelector('button')?.getBoundingClientRect();
          if (!box) return;
          const room = align === 'up' ? box.top - 20 : window.innerHeight - box.bottom - 20;
          pop.style.maxHeight = `${Math.max(120, Math.round(room))}px`;
        }}
        onClick={event => {
          if ((event.target as Element).closest('a, button:not([data-keep])'))
            event.currentTarget.hidePopover();
        }}
      >
        {children}
      </div>
    </span>
  );
}

export function MenuItem({
  icon,
  title,
  sub,
  href,
  onClick,
  danger,
}: {
  icon?: string;
  title: ComponentChildren;
  sub?: ComponentChildren;
  /** An outside page; in-app links use Link. */
  href?: string;
  onClick?: () => void;
  /** Destructive: red on hover. */
  danger?: boolean;
}) {
  const inner = (
    <>
      {icon ? <Icon d={icon} /> : null}
      <span class="grow">
        {title}
        {sub ? <small>{sub}</small> : null}
      </span>
    </>
  );
  const cls = `pop-item${sub ? ' rich' : ''}${danger ? ' danger' : ''}`;

  if (href)
    return (
      <a
        class={cls}
        href={href}
        {...(/^https?:\/\//.test(href) ? { target: '_blank', rel: 'noreferrer' } : {})}
      >
        {inner}
      </a>
    );
  return (
    <button type="button" class={cls} onClick={onClick}>
      {inner}
    </button>
  );
}

/** A fixed "+n more" that opens the rest in a scrolling list, on hover or click. */
export function MoreList({ label, children }: { label: string; children: ComponentChildren }) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const hover = (open: boolean) => (event: PointerEvent) => {
    if (event.pointerType === 'mouse') list.current!.togglePopover(open);
  };

  return (
    <span class="more" onPointerEnter={hover(true)} onPointerLeave={hover(false)}>
      <button popovertarget={id} type="button">
        {label}
      </button>
      <div id={id} ref={list} class="more-list scroll-box" popover="auto">
        {children}
      </div>
    </span>
  );
}

/** One choice in a menu section; the picked one shows a check. */
export function MenuRadio({
  on,
  onPick,
  children,
}: {
  on: boolean;
  onPick: () => void;
  children: ComponentChildren;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={on}
      class={on ? 'pop-item on' : 'pop-item'}
      onClick={onPick}
    >
      <span class="grow">{children}</span>
      {on ? <Icon d={iCheck} /> : null}
    </button>
  );
}
