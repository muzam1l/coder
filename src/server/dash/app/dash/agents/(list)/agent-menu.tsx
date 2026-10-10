import { Link } from '@wular/pnext/link';

import { iAgent } from '@/comps/ui/icons';
import { Icon } from '@/comps/ui/icon';

/** Make a dashboard agent; importing from a repository starts from the same page. */
export function NewAgentMenu() {
  return (
    <Link class="btn" href="/dash/agents/new">
      <Icon d={iAgent} />
      New agent
    </Link>
  );
}
