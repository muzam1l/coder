import { dynamic } from '@wular/pnext/dynamic';

import { AuthPanel } from '@/comps/frame/auth-panel';
import { Outcome, readOutcome } from '@/app/dash/setup/outcome';

const CreateLink = dynamic(() => import('@/app/dash/setup/create-link').then(m => m.CreateLink));

/** A signed link from `coder server app create`: its transaction alone authorizes it, with no workspace, and shows how it ended. */
export default async function ServerAppPage({
  request,
  params,
}: {
  request?: Request;
  params: Promise<Record<string, string | string[]>>;
}) {
  if (!request) return null;
  const { id: raw } = await params;
  const integration = Array.isArray(raw) ? raw[0]! : raw!;
  const search = new URL(request.url).searchParams;
  const outcome = readOutcome(search);

  return (
    <AuthPanel
      tag="server app"
      title="Create app"
      lead="This app is shared by every workspace on this server."
    >
      {outcome ? (
        <Outcome outcome={outcome} catalog={[]} />
      ) : (
        <CreateLink integration={integration} state={Object.fromEntries(search)} />
      )}
    </AuthPanel>
  );
}
