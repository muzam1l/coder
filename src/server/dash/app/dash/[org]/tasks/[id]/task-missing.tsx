'use client';

import { useRouter } from '@wular/pnext/navigation/client';
import { useOrg } from '@/comps/nav/org';
import { Button, LinkButton } from '@/comps/ui/button';
import { Empty } from '@/comps/ui/card';

/** A task that is gone, or one this member can't see: the same answer for both. */
export function TaskMissing() {
  const nav = useRouter();
  const org = useOrg();

  return (
    <div class="task-missing">
      <Empty
        title="Task not found"
        actions={
          <>
            <Button variant="outline" onClick={() => nav.refresh()}>
              Refresh
            </Button>
            <LinkButton href="/dash/[org]/tasks" params={{ org }}>
              Go to tasks
            </LinkButton>
          </>
        }
      >
        It may have been deleted, or it ran somewhere you can't see.
      </Empty>
    </div>
  );
}
