'use client';

import { Link, type LinkProps } from '@wular/pnext/link';
import type { RefObject } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { useLinkStatus, usePathname } from '@wular/pnext/navigation/client';

import { pathOf } from './to';

/** A link marked current when the address is its path, or under `within`. */
export function CurrentLink({
  within,
  children,
  onClick,
  ...link
}: LinkProps & { within?: string }) {
  const at = usePathname();
  const current =
    at === pathOf(link) || (within !== undefined && (at === within || at.startsWith(`${within}/`)));

  const anchor = useRef<HTMLAnchorElement>(null);

  return (
    <Link
      {...link}
      aria-current={current ? 'page' : undefined}
      onClick={event => {
        anchor.current = event.currentTarget;
        onClick?.(event);
      }}
    >
      {children}
      <PendingCurrent anchor={anchor} current={current} />
    </Link>
  );
}

// Link status belongs to a child of Link's context. A pending link marks itself, and CSS moves the underline there until the address catches up.
function PendingCurrent({
  anchor,
  current,
}: {
  anchor: RefObject<HTMLAnchorElement>;
  current: boolean;
}) {
  const { pending } = useLinkStatus();
  useLayoutEffect(() => {
    if (!anchor.current) return;
    if (pending && !current) anchor.current.setAttribute('data-pending', '');
    else anchor.current.removeAttribute('data-pending');
  }, [pending, current]);
  return null;
}
