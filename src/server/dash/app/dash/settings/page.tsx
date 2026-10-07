import { redirect } from '@wular/pnext/navigation';

/** Settings opens on its first tab. */
export default function SettingsPage({ request }: { request?: Request }) {
  if (!request) return null;
  redirect('/dash/settings/credentials');
}
