'use client';

import { useState } from 'preact/hooks';

import { iLeft, iRight } from '@/comps/ui/icons';
import { Icon } from '@/comps/ui/icon';

const COOKIE = 'side';

/** Collapses the sidebar to its icons; the choice lives in a cookie so the next page renders that way at once. */
export function SideToggle({ collapsed: initial }: { collapsed: boolean }) {
  const [collapsed, setCollapsed] = useState(initial);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.querySelector('.app')?.classList.toggle('side-min', next);
    document.cookie = `${COOKIE}=${next ? 'min' : ''}; path=/; max-age=${next ? 31536000 : 0}; samesite=lax`;
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
