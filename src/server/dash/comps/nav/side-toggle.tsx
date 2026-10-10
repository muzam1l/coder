'use client';

import { useEffect, useState } from 'preact/hooks';

import { iLeft, iRight } from '@/comps/ui/icons';
import { Icon } from '@/comps/ui/icon';

const COOKIE = 'side';

/** Collapses the sidebar to its icons; a click is saved in a cookie so the next page renders that way at once. */
export function SideToggle({ collapsed: initial }: { collapsed: boolean }) {
  const [collapsed, setCollapsed] = useState(initial);

  // Without a saved choice the layout script collapses mid-width screens, so the label follows the class.
  useEffect(() => {
    const app = document.querySelector('.app');
    if (!app) return;
    const sync = () => setCollapsed(app.classList.contains('side-min'));
    sync();
    const watch = new MutationObserver(sync);
    watch.observe(app, { attributes: true, attributeFilter: ['class'] });
    return () => watch.disconnect();
  }, []);

  const toggle = () => {
    const next = !collapsed;
    document.querySelector('.app')?.classList.toggle('side-min', next);
    document.cookie = `${COOKIE}=${next ? 'min' : 'max'}; path=/; max-age=31536000; samesite=lax`;
  };
  return (
    <button
      type="button"
      class="icon-btn side-toggle"
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      data-tip={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      onClick={toggle}
    >
      <Icon d={collapsed ? iRight : iLeft} />
    </button>
  );
}
