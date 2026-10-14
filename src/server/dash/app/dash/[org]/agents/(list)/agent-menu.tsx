import { iAgent } from '@/comps/ui/icons';
import { LinkButton } from '@/comps/ui/button';
import { useOrg } from '@/comps/nav/org';

/** Make a dashboard agent; importing from a repository starts from the same page. */
export function NewAgentMenu() {
  return (
    <LinkButton href="/dash/[org]/agents/new" params={{ org: useOrg() }} leftIcon={iAgent}>
      New agent
    </LinkButton>
  );
}
