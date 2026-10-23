import { Link } from '@wular/pnext/link';

import { Icon } from '@/comps/ui/icon';
import { iExternal } from '@/comps/ui/icons';

/** A model field's hint: the default chain runs, with a link to it, unless a model picked here overrides it; `own` names an agent.json model that comes first. */
export const ChainHint = ({ org, own }: { org: string; own?: string }) =>
  own ? (
    <>{own} from agent.json, unless picked here</>
  ) : (
    <>
      <Link class="link" href="/dash/[org]/settings/[tab]" params={{ org, tab: 'models' }}>
        default chain
        <Icon d={iExternal} />
      </Link>{' '}
      unless picked here
    </>
  );
