import type { ComponentChildren } from 'preact';
import { Link } from '@wular/pnext/link';

import { Icon } from '@/comps/ui/icon';
import { iExternal } from '@/comps/ui/icons';

/** The default chain, linked to where it is set. */
export const ChainLink = ({
  org,
  children = 'default chain',
}: {
  org: string;
  children?: ComponentChildren;
}) => (
  <Link class="link" href="/dash/[org]/settings/[tab]" params={{ org, tab: 'models' }}>
    {children}
    <Icon d={iExternal} />
  </Link>
);

/** A model field's hint: the default chain runs, with a link to it, unless a model picked here overrides it; `own` names an agent.json model that comes first. */
export const ChainHint = ({ org, own }: { org: string; own?: string }) =>
  own ? (
    <>{own} from agent.json, unless picked here</>
  ) : (
    <>
      <ChainLink org={org} /> unless picked here
    </>
  );
