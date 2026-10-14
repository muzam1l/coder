'use client';

import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';

import { Back } from '@/comps/frame/page-head';
import { LinkButton, type Look } from '@/comps/ui/button';
import { useOrg } from '@/comps/nav/org';
import { BACK_COOKIE, rememberedBack, type Remembered } from '@/comps/nav/back-cookie';

/** Settings' credentials tab; it links back to this page, named `label` where its section name is not enough. */
export function CredentialsLink({
  label,
  children,
  ...look
}: Look & {
  label?: string;
  children: ComponentChildren;
}) {
  const remember = () => {
    const value = encodeURIComponent(JSON.stringify({ path: location.pathname, label }));
    document.cookie = `${BACK_COOKIE}=${value}; path=/dash; max-age=600; samesite=lax`;
  };

  return (
    <LinkButton
      {...look}
      href="/dash/[org]/settings/[tab]"
      params={{ org: useOrg(), tab: 'credentials' }}
      onClick={remember}
    >
      {children}
    </LinkButton>
  );
}

/** The back link Settings shows for the page a link remembered; leaving Settings forgets it, so a later visit has none. */
export function RememberedBack({ initial }: { initial: Remembered | null }) {
  const org = useOrg();
  const back = typeof document === 'undefined' ? initial : rememberedBack(document.cookie);
  useEffect(
    () => () =>
      void setTimeout(() => {
        if (location.pathname.split('/')[3] !== 'settings')
          document.cookie = `${BACK_COOKIE}=; path=/dash; max-age=0`;
      }),
    [],
  );

  return back ? (
    <Back href="/dash/[org]" params={{ org }} label="Back" back={back.path} named={back.label} />
  ) : null;
}
