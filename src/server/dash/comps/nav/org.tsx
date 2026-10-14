'use client';

import { Link, type LinkProps } from '@wular/pnext/link';
import { useParams } from '@wular/pnext/navigation/client';

import { Back } from '@/comps/frame/page-head';
import { linkOf, type To } from '@/comps/nav/to';

/** The organization in the address, `/dash/<org>/…`. */
export const useOrg = () => useParams<'/dash/[org]'>().org;

/** A link to a page of the address's organization, for frames that render without route params; `params` adds the rest. */
export function OrgLink({
  href,
  params,
  ...anchor
}: Omit<LinkProps, 'href' | 'params' | 'search'> & {
  href: Extract<To['href'], `/dash/[org]${string}`>;
  params?: Record<string, string>;
}) {
  return <Link {...anchor} {...linkOf({ href, params: { ...params, org: useOrg() } } as To)} />;
}

/** `Back` to a section of the address's organization, for frames that render without route params. */
export function OrgBack({
  href,
  label,
}: {
  href: '/dash/[org]/agents' | '/dash/[org]/tasks';
  label: string;
}) {
  return <Back href={href} params={{ org: useOrg() }} label={label} />;
}
