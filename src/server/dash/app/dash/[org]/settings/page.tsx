import { redirect } from '@wular/pnext/navigation';

import { orgOf } from '@/api/load';

/** Settings opens on its first tab. */
export default function SettingsPage({ request }: { request?: Request }) {
  if (!request) return null;
  const org = orgOf(request);
  redirect('/dash/[org]/settings/[tab]', { params: { org, tab: 'connections' } });
}
