import { Link } from '@wular/pnext/link';

/** Make a dashboard agent; importing from a repository starts from the same page. */
export function NewAgentMenu() {
  return (
    <Link class="btn" href="/dash/agents/new">
      New agent
    </Link>
  );
}
