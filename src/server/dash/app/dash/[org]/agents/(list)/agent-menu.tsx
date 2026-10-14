import { iAgent } from '@/comps/ui/icons';
import { Icon } from '@/comps/ui/icon';
import { OrgLink } from '@/comps/nav/org';

/** Make a dashboard agent; importing from a repository starts from the same page. */
export function NewAgentMenu() {
  return (
    <OrgLink class="btn" href="/dash/[org]/agents/new">
      <Icon d={iAgent} />
      New agent
    </OrgLink>
  );
}
