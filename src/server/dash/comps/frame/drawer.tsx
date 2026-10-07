'use client';

import './drawer.css';

import { useEffect, useState } from 'preact/hooks';
import { usePathname } from '@wular/pnext/navigation/client';

import { iMenu } from '@/comps/ui/icons';
import { Icon } from '@/comps/ui/icon';

/** The phone layout's navigation drawer: its button and the scrim behind it; Escape or a new page closes it. */
export function Drawer() {
  const [open, setOpen] = useState(false);
  const path = usePathname();

  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    document.documentElement.classList.toggle('drawer', open);
    if (!open) return;

    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        class="icon-btn only-m"
        aria-label="Open navigation"
        onClick={() => setOpen(!open)}
      >
        <Icon d={iMenu} />
      </button>
      <div class="scrim" onClick={() => setOpen(false)} />
    </>
  );
}
