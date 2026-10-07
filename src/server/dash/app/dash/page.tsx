import { redirect } from '@wular/pnext/navigation';

import { load } from '@/api/load';
import { localServer } from '@/api/types';

/** A local server lands on Tasks, a cloud one on Agents; an account that fails to load is the layout's to handle. */
export default async function DashboardHome({ request }: { request?: Request }) {
  if (!request) return null;
  const me = await load(request)
    .me()
    .catch(() => undefined);
  if (!me) return null;
  redirect(localServer(me) ? '/dash/tasks' : '/dash/agents');
}
