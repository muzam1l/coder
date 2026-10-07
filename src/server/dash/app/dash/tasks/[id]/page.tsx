import './task-view.css';
import { dynamic } from '@wular/pnext/dynamic';

import { zoneOf } from '@/utils/format';
import { load } from '@/api/load';
import { Page } from '@/comps/frame/page-head';
import { Settle } from '@/comps/frame/stream';

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
  const tz = zoneOf(request);

  return (
    <Page>
      <Settle load={() => task.then(row => <TaskView initial={row} tz={tz} />)} />
    </Page>
  );
}
