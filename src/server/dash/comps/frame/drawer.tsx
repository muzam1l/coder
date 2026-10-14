'use client';

import './drawer.css';

import { useEffect, useState } from 'preact/hooks';
import { usePathname } from '@wular/pnext/navigation/client';

import { iMenu } from '@/comps/ui/icons';
import { IconButton } from '@/comps/ui/button';

/** The phone layout's navigation drawer: its button and the scrim behind it; Escape or a new page closes it. */
export function Drawer() {
  const path = usePathname();
  // Open on the page it opened on, so a new page closes it.
  const [openOn, setOpenOn] = useState<string>();
  const open = openOn === path;
  const setOpen = (next: boolean) => setOpenOn(next ? path : undefined);

  useEffect(() => {
    document.documentElement.classList.toggle('drawer', open);
    if (!open) return;

    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <IconButton
        icon={iMenu}
        label="Open navigation"
        class="only-m"
        onClick={() => setOpen(!open)}
      />
      <div class="scrim" onClick={() => setOpen(false)} />
    </>
  );
}
