'use client';

import { usePathname } from '@wular/pnext/navigation/client';

import { Icon } from '@/comps/ui/icon';
import { iAlert } from '@/comps/ui/icons';
import { LinkButton } from '@/comps/ui/button';
import { Notice } from '@/comps/ui/notice';
import { useOrg } from '@/comps/nav/org';

/** An agent installed on no platform yet, with the way to its Platforms tab; on that tab the button only holds the notice's height. */
export function NeedsPlatform({ agent }: { agent: { id: string; name: string } }) {
  const org = useOrg();
  const here = usePathname().endsWith(`/agents/${encodeURIComponent(agent.id)}/platforms`);

  return (
    <Notice tone="warning" slim>
      <Icon d={iAlert} />
      <span class="grow">{agent.name} is not on any platform yet.</span>
      <LinkButton
        variant="outline"
        size="sm"
        href="/dash/[org]/agents/[slug]/platforms"
        params={{ org, slug: agent.id }}
        aria-hidden={here || undefined}
      >
        Set up platforms
      </LinkButton>
    </Notice>
  );
}
