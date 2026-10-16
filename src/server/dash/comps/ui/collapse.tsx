'use client';

import './collapse.css';

import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { Button } from './button';

/** Long content cut to its first `lines` lines under a fade, with a Show more toggle. */
export function Collapse({
  lines = 10,
  class: cls,
  children,
}: {
  lines?: number;
  /** The content box's own class, as `body md`. */
  class?: string;
  children: ComponentChildren;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const el = box.current!;
    const measure = () => setLong(open || el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // The clamped box keeps its size as content grows, so content changes measure too.
    const changes = new MutationObserver(measure);
    changes.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      changes.disconnect();
    };
  }, [open]);

  return (
    <div class={`collapse${long ? ' long' : ''}${open ? ' open' : ''}`} style={`--lines:${lines}`}>
      <div class={cls ? `collapse-box ${cls}` : 'collapse-box'} ref={box}>
        {children}
      </div>
      {long ? (
        <Button
          variant="ghost"
          size="sm"
          class="more-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : 'Show more'}
        </Button>
      ) : null}
    </div>
  );
}
