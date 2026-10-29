import type { ComponentChildren } from 'preact';

import { linkUrl } from '@coder/utils/url';

/** A platform page as a link in a new tab, when its address passes the platform's link check; else the plain text. */
export function PlatformLink({
  href,
  hosts,
  children,
}: {
  href?: string;
  hosts?: readonly string[];
  children: ComponentChildren;
}) {
  const url = hosts && linkUrl(href, hosts);
  if (!url) return <>{children}</>;

  return (
    <a class="link" href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
