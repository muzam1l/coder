import './page-head.css';
import type { ComponentChildren } from 'preact';

import { iLeft } from '@/comps/ui/icons';
import { Link } from '@wular/pnext/link';
import type { To } from '@/comps/nav/to';
import { HEADS } from '@/comps/frame/heads';
import { Icon } from '@/comps/ui/icon';
import { Sentinel } from '@/comps/ui/sentinel';

export function Page({ narrow, children }: { narrow?: boolean; children: ComponentChildren }) {
  return <div class={narrow ? 'page narrow' : 'page'}>{children}</div>;
}

/** A same-origin `/dash` path from a `back` search param, named for its agent or section, or nothing. */
function backTo(back: string | null | undefined): { to: To; label: string } | undefined {
  if (!back?.startsWith('/')) return;
  const url = new URL(back, 'http://dash');
  if (url.origin !== 'http://dash' || !/^\/dash(\/|$)/.test(url.pathname)) return;
  const [, , section, slug] = url.pathname.split('/');
  let label: string = HEADS[section as keyof typeof HEADS]?.title ?? 'Back';
  if (section === 'agents' && slug)
    try {
      label = decodeURIComponent(slug);
    } catch {}
  return { to: { href: url.pathname as To['href'], search: url.searchParams } as To, label };
}

/** Back to the logical parent, wherever the visitor came from; a `back` search param wins. */
export function Back({ label, back, ...to }: To & { label: string; back?: string | null }) {
  const param = backTo(back);
  return (
    <Link class="back" {...(param?.to ?? to)}>
      <Icon d={iLeft} />
      {param?.label ?? label}
    </Link>
  );
}

/** The page title row with its meta and actions, and one muted lead line; it sticks under the top bar and turns compact there. */
export function PageHead({
  title,
  lead,
  actions,
  meta,
  back,
}: {
  title: ComponentChildren;
  lead?: ComponentChildren;
  actions?: ComponentChildren;
  meta?: ComponentChildren;
  /** A `Back` link on its own line above the title. */
  back?: ComponentChildren;
}) {
  return (
    <>
      <Sentinel />
      <header class="head">
        <div>
          {back}
          <div class="title-row">
            <h1>{title}</h1>
            {meta ? <div class="meta">{meta}</div> : null}
          </div>
          {lead ? <p class="lead">{lead}</p> : null}
        </div>
        {actions ? <div class="actions">{actions}</div> : null}
      </header>
    </>
  );
}
