'use client';

import './menu.css';

import type { ComponentChildren } from 'preact';
import { useId, useRef } from 'preact/hooks';

import { Button, IconButton, type Look } from './button';
import { iInfo } from './icons';
import { Icon } from './icon';

/** A button and its popover panel, placed at the button; picking an item, an outside click or Escape closes it. */
export function Menu({
  summary,
  summaryClass,
  button,
  label,
  tip,
  align = 'right',
  wide,
  class: cls,
  children,
}: {
  summary: ComponentChildren;
  summaryClass?: string;
  /** The summary as an `IconButton`, or a `Button` with this look. */
  button?: 'icon' | Look;
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
      {button === 'icon' ? (
        <IconButton popovertarget={id} label={label ?? ''}>
          {summary}
        </IconButton>
      ) : button ? (
        <Button {...button} popovertarget={id} aria-label={label} title={tip ? undefined : label}>
          {summary}
        </Button>
      ) : (
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
      )}
      <div
        id={id}
        class={wide ? 'pop wide' : 'pop'}
        popover="auto"
        onBeforeToggle={event => {
          // Opens on its side of the button when it fits there, else on the roomier side, scrolling only within that room.
          if ((event as ToggleEvent).newState !== 'open') return;
          const pop = event.currentTarget as HTMLElement;
          const box = pop.parentElement?.querySelector('button')?.getBoundingClientRect();
          if (!box) return;
          pop.style.cssText = 'display: block; visibility: hidden; max-height: none';
          const height = pop.offsetHeight;
          pop.style.cssText = '';
          const below = window.innerHeight - box.bottom - 20;
          const above = box.top - 20;
          const [own, other] = align === 'up' ? [above, below] : [below, above];
          const flip = height > own && other > own;
          pop.classList.toggle('flip', flip);
          pop.style.maxHeight = `${Math.max(120, Math.round(flip ? other : own))}px`;
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

/** A fixed "+n more" that opens the rest in a scrolling list, on hover or click; `title` names an icon-only trigger. */
export function MoreList({
  label,
  title,
  class: cls,
  children,
}: {
  label: ComponentChildren;
  title?: string;
  class?: string;
  children: ComponentChildren;
}) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const closing = useRef<ReturnType<typeof setTimeout>>();
  // Closing waits a beat, so the pointer can cross the gap into the list.
  const hover = (open: boolean) => (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    clearTimeout(closing.current);
    if (open) list.current!.togglePopover(true);
    else closing.current = setTimeout(() => list.current?.togglePopover(false), 150);
  };

  return (
    <span
      class={cls ? `more ${cls}` : 'more'}
      onPointerEnter={hover(true)}
      onPointerLeave={hover(false)}
    >
      <button popovertarget={id} type="button" aria-label={title}>
        {label}
      </button>
      <div id={id} ref={list} class="more-list scroll-box" popover="auto">
        {children}
      </div>
    </span>
  );
}

/** An i that opens its explanation in the same hover card as "+n more". */
export const InfoTip = ({ label, children }: { label: string; children: ComponentChildren }) => (
  <MoreList label={<Icon d={iInfo} />} title={label} class="info">
    {children}
  </MoreList>
);
