import '@/app/dash/[org]/settings/[tab]/list.css';
import { ClientError } from '@coder/client';
import { dynamic } from '@wular/pnext/dynamic';
import { notFound, redirect } from '@wular/pnext/navigation';

import { load } from '@/api/load';
import { Page, PageHead } from '@/comps/frame/page-head';
import { Button, LinkButton } from '@/comps/ui/button';
import { Card, FoldCard } from '@/comps/ui/card';
import { formatDate, reasonText, zoneOf } from '@/utils/format';
import { Row } from '@/app/dash/[org]/settings/[tab]/list';
import { outcomeText, outcomeTitle, readOutcome, succeeded } from '@/app/dash/[org]/setup/outcome';
import { OperatorApps } from './operator-apps';

const OutcomeDialog = dynamic(() =>
  import('@/app/dash/[org]/setup/outcome-dialog').then(m => m.OutcomeDialog),
);

const SIGN_IN_ERRORS: Record<string, string> = {
  stale: 'That sign-in was not fresh enough. Sign in again.',
  denied: 'That account is not an operator of this server, or not the one signed in here.',
  lost: 'You signed in, but operator mode did not start. Sign in again.',
};

function SignInAgain({ error }: { error: string | null }) {
  return (
    <Card title="Sign in again">
      <div class="body prose">
        <p>
          Operator mode needs a fresh sign-in with Wular Auth. It ends after an hour, or after 15
          minutes without activity. The rest of the dashboard keeps your current session.
        </p>
        {error && SIGN_IN_ERRORS[error] ? (
          <p class="flash err" role="alert">
            {SIGN_IN_ERRORS[error]}
          </p>
        ) : null}
        <Button href="/api/auth/sign-in?operator=1">Sign in again</Button>
      </div>
    </Card>
  );
}

/** The server-wide area only `SERVER_OPERATORS` see: built-in apps per platform and the audit log. */
export default async function OperatorPage({ request }: { request?: Request }) {
  if (!request) return null;
  const me = await load(request)
    .me()
    .catch(() => undefined);
  if (!me) return null;
  if (!me.operator) notFound();

  const head = (
    <PageHead
      title="Operator"
      lead="Server-wide setup that workspace owners and members never see."
    />
  );
  try {
    const [apps, audit] = await Promise.all([
      load(request).operator.apps(),
      load(request).operator.audit(),
    ]);
    const tz = zoneOf(request);
    // Back from creating a shared app on its platform.
    const outcome = readOutcome(new URL(request.url).searchParams);
    const name =
      apps.platforms.find(row => row.integration === outcome?.platform)?.name ??
      outcome?.platform ??
      'the platform';
    const org = me.organization?.slug;

    return (
      <Page>
        {head}
        <OperatorApps first={apps} />
        {outcome ? (
          <OutcomeDialog
            ok={succeeded(outcome)}
            title={outcomeTitle(outcome, name)}
            text={outcomeText(outcome, name)}
            issues={me.server?.issuesUrl}
          >
            {succeeded(outcome) && org ? (
              <LinkButton href="/dash/[org]/agents" params={{ org }}>
                Connect it in your workspace
              </LinkButton>
            ) : null}
          </OutcomeDialog>
        ) : null}
        <FoldCard
          title={
            <>
              Audit log<span class="n">{audit.length}</span>
            </>
          }
          note="Every operator action, newest first"
          open="Show"
        >
          {audit.length ? (
            <div class="table-scroll">
              <table class="rows settings">
                <tbody>
                  {audit.map(entry => (
                    <Row
                      key={`${entry.at}${entry.target}`}
                      title={entry.action}
                      sub={`${entry.target}, by ${entry.actor.email ?? entry.actor.name ?? 'the admin token'}, ${formatDate(entry.at, tz)}`}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p class="body muted">No operator actions yet.</p>
          )}
        </FoldCard>
      </Page>
    );
  } catch (error) {
    const params = new URL(request.url).searchParams;
    const signInError = params.get('error') ?? (params.has('entered') ? 'lost' : null);
    // Operator mode ended: sign in again at once, unless a sign-in just returned here, so it never loops.
    if (error instanceof ClientError && error.status === 401 && !signInError)
      redirect('/api/auth/sign-in?operator=1');

    return (
      <Page>
        {head}
        {error instanceof ClientError && error.status === 401 ? (
          <SignInAgain error={signInError} />
        ) : (
          <Card tone="danger">
            <p class="body prose">{reasonText(error)}</p>
          </Card>
        )}
      </Page>
    );
  }
}
