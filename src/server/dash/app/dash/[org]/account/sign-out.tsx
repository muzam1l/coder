'use client';

import { signOut } from '@/utils/client';
import { iOut } from '@/comps/ui/icons';
import { Button } from '@/comps/ui/button';
import { MenuItem } from '@/comps/ui/menu-items';

/** Ends this browser session; `menu` makes it the account menu's item. */
export function SignOut({ menu }: { menu?: boolean }) {
  const out = () => void signOut().catch(() => location.reload());

  return menu ? (
    <MenuItem icon={iOut} title="Sign out" onClick={out} />
  ) : (
    <Button variant="secondary" danger onClick={out}>
      Sign out
    </Button>
  );
}
