import type { WorkspaceLimits } from '@coder/client/types';
import { cpuMinutesUsed } from '@coder/core/errors';
import { iAlert, iInfo } from '@/comps/ui/icons';
import { Icon } from '@/comps/ui/icon';
import { Button, LinkButton } from '@/comps/ui/button';
import { Notice } from '@/comps/ui/notice';

/** Shows once the CPU minutes are half used, and again when they run out. */
export function MinutesNotice({ org, limits }: { org: string; limits?: WorkspaceLimits }) {
  const cpuMinutes = limits?.cpuMinutes;
  if (!cpuMinutes || cpuMinutes.used < cpuMinutes.limit / 2) return null;
  const { limit } = cpuMinutes;
  const full = cpuMinutes.used >= limit;

  return (
    <Notice tone={full ? 'warning' : undefined}>
      <Icon d={full ? iAlert : iInfo} />
      <span class="grow">
        {full
          ? cpuMinutesUsed(limit)
          : `This workspace used half of its ${limit} CPU minutes this month. Your own runners have no minute limit.`}
      </span>
      <LinkButton
        href="/dash/[org]/settings/[tab]"
        params={{ org, tab: 'runners' }}
        variant="outline"
        size="sm"
      >
        Add runner
      </LinkButton>
      {limits?.plansUrl ? (
        <Button href={limits.plansUrl} variant="ghost" size="sm">
          See plans
        </Button>
      ) : null}
    </Notice>
  );
}
