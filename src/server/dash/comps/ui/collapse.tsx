'use client';

import './collapse.css';

import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

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
    return () => observer.disconnect();
  }, [children, open]);

  return (
    <div class={`collapse${long ? ' long' : ''}${open ? ' open' : ''}`} style={`--lines:${lines}`}>
      <div class={cls ? `collapse-box ${cls}` : 'collapse-box'} ref={box}>
        {children}
      </div>
      {long ? (
        <button
          type="button"
          class="btn ghost sm more-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}
