import '@/app/dash/[org]/settings/[tab]/list.css';
import { ClientError } from '@coder/client';
import { notFound } from '@wular/pnext/navigation';

import { load } from '@/api/load';
import { Page, PageHead } from '@/comps/frame/page-head';
import { Button } from '@/comps/ui/button';
import { Card, FoldCard } from '@/comps/ui/card';
import { formatDate, reasonText, zoneOf } from '@/utils/format';
import { Row } from '@/app/dash/[org]/settings/[tab]/list';
import { OperatorApps } from './operator-apps';

const SIGN_IN_ERRORS: Record<string, string> = {
  stale: 'That sign-in was not fresh enough. Sign in again.',
  denied: 'That account is not an operator of this server, or not the one signed in here.',
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

    return (
      <Page>
        {head}
        <OperatorApps first={apps} />
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
    return (
      <Page>
        {head}
        {error instanceof ClientError && error.status === 401 ? (
          <SignInAgain error={new URL(request.url).searchParams.get('error')} />
        ) : (
          <Card tone="danger">
            <p class="body prose">{reasonText(error)}</p>
          </Card>
        )}
      </Page>
    );
  }
}
