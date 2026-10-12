import { Link } from '@wular/pnext/link';

import { LoadingCard } from '@/comps/frame/loading-card';

export const Lead = () => (
  <p class="tab-lead">
    <b>Handles</b> are the agent's own apps on platforms. Install one where the agent is triggered
    from: @mentions and events there start tasks, and it replies as itself.
  </p>
);

/** Under the handles: where everything else the agent's tasks reach is managed. */
export const ConnectionsLine = () => (
  <p class="tab-lead">
    <b>Connections</b> reach everything else: an API key, an MCP server, or a member's own account.{' '}
    <Link class="link" href="/dash/settings/[tab]" params={{ tab: 'connections' }}>
      Manage connections
    </Link>
  </p>
);

/** The platforms tab before its apps arrive. */
export default function PlatformsLoading() {
  return (
    <>
      <Lead />
      <LoadingCard title="Handles" label="Loading platforms" />
    </>
  );
}
