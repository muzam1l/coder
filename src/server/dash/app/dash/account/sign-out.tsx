'use client';

import type { ComponentChildren } from 'preact';

import { signOut } from '@/utils/client';
import { iOut } from '@/comps/ui/icons';
import { Icon } from '@/comps/ui/icon';

export function SignOut({
  class: cls,
  icon,
  children,
}: {
  class: string;
  icon?: boolean;
  children: ComponentChildren;
}) {
  return (
    <button type="button" class={cls} onClick={() => void signOut().catch(() => location.reload())}>
      {icon ? <Icon d={iOut} /> : null}
      {children}
    </button>
  );
}
