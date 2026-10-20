import { dynamic } from '@wular/pnext/dynamic';
import { redirect } from '@wular/pnext/navigation';

import { load } from '@/api/load';
import { AuthPanel } from '@/comps/frame/auth-panel';
import { Button, LinkButton } from '@/comps/ui/button';
import { Outcome, readOutcome } from '@/app/dash/[org]/setup/outcome';

const CreateLink = dynamic(() =>
  import('@/app/dash/[org]/setup/create-link').then(m => m.CreateLink),
);

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
  // Signed in: where the app is connected next; a link from the CLI may come without a session.
  const me = outcome
    ? await load(request)
        .me()
        .catch(() => undefined)
    : undefined;
  const org = me?.organization?.slug;
  // An operator ends on the Operator page with the outcome as a dialog; the panel is for links opened without one.
  if (outcome && org && me?.operator) {
    const query = new URLSearchParams(search);
    query.delete('tx');
    redirect(`/dash/${encodeURIComponent(org)}/operator?${query}`);
  }

  return (
    <AuthPanel
      tag="server app"
      title="Create app"
      lead="This app is shared by every workspace on this server."
    >
      {outcome ? (
        <Outcome outcome={outcome} catalog={[]}>
          {org ? (
            <LinkButton href="/dash/[org]/agents" params={{ org }}>
              Connect it in your workspace
            </LinkButton>
          ) : (
            <Button href="/dash">Open dashboard</Button>
          )}
        </Outcome>
      ) : (
        <CreateLink integration={integration} state={Object.fromEntries(search)} />
      )}
    </AuthPanel>
  );
}
