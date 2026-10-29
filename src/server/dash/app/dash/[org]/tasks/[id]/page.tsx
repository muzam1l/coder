import './task-view.css';
import { dynamic } from '@wular/pnext/dynamic';

import { zoneOf } from '@/utils/format';
import { ClientError } from '@coder/client';
import type { Me } from '@coder/client/types';
import { load } from '@/api/load';
import { Page } from '@/comps/frame/page-head';
import { Settle } from '@/comps/frame/stream';
import { TaskMissing } from './task-missing';

// Hydrates with the page: the reply box is focused and the activity follows the run at once.
const TaskView = dynamic(() => import('./task-view').then(m => m.TaskView));

export default async function TaskPage({
  request,
  params,
}: {
  request?: Request;
  params: Promise<Record<string, string | string[]>>;
}) {
  if (!request) return null;
  const { id: raw } = await params;
  const id = Array.isArray(raw) ? raw[0]! : raw!;
  const task = load(request).tasks.get(id);
  const me = load(request)
    .me()
    .catch((): Me => ({}));
  const catalog = load(request)
    .integrations.list()
    .catch(() => []);
  const tz = zoneOf(request);

  return (
    <Page>
      <Settle
        load={() =>
          Promise.all([task, me, catalog]).then(
            ([row, who, integrations]) => (
              <TaskView
                initial={row}
                tz={tz}
                me={who}
                integration={integrations.find(entry => entry.id === row.task.event?.integration)}
              />
            ),
            error => {
              if (error instanceof ClientError && error.status === 404) return <TaskMissing />;
              throw error;
            },
          )
        }
      />
    </Page>
  );
}
