'use client';

import './sentinel.css';

import { useEffect, useRef } from 'preact/hooks';

/** Goes right before a page head: the head sticks under the top bar and turns compact there, its old height kept as margin so nothing under it moves. */
export function Sentinel() {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const mark = ref.current!;
    // Inside an island the head follows the island's host.
    const head = (mark.nextElementSibling ?? mark.parentElement!.nextElementSibling) as HTMLElement;
    const page = head.closest<HTMLElement>('.page');

    // How much shorter the compact head is; it compacts only once that much has scrolled under it, so no gap opens above what follows.
    const shrink = () => {
      const stuck = head.classList.contains('stuck');
      const before = head.offsetHeight;
      head.classList.toggle('stuck', !stuck);
      const after = head.offsetHeight;
      head.classList.toggle('stuck', stuck);
      return Math.max(0, stuck ? after - before : before - after);
    };

    let observer: IntersectionObserver | undefined;
    const watch = () => {
      observer?.disconnect();
      // the head sticks at 56px; it compacts once its top is that much further up
      const line = 56 - shrink();
      observer = new IntersectionObserver(
        ([entry]) => {
          const stuck = !entry!.isIntersecting && entry!.boundingClientRect.top < line;
          if (stuck === head.classList.contains('stuck')) return;

          // The page keeps its height while the head changes, or a page just taller than the viewport clamps its scroll to 0.
          const tall = head.offsetHeight;
          if (page) page.style.paddingBottom = `${tall}px`;
          head.classList.toggle('stuck', stuck);
          head.style.marginBottom = stuck ? `${tall - head.offsetHeight}px` : '';
          if (page) page.style.paddingBottom = '';
        },
        { rootMargin: `${-line}px 0px 0px 0px` },
      );
      observer.observe(mark);
    };
    watch();

    // Tabs and filter rows stick under the head at its current height; a new width changes how much it compacts by.
    let width = head.offsetWidth;
    const sized = new ResizeObserver(() => {
      page?.style.setProperty('--head', `${head.offsetHeight}px`);
      if (head.offsetWidth === width) return;
      width = head.offsetWidth;
      watch();
    });
    sized.observe(head, { box: 'border-box' });
    return () => {
      observer?.disconnect();
      sized.disconnect();
      page?.style.removeProperty('--head');
    };
  }, []);

  return <i class="sentinel" ref={ref} />;
}
