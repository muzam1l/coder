import './page.css';
import type { ComponentChildren } from 'preact';

import { iKey } from '@/comps/ui/icons';
import { load } from '@/api/load';
import { initial, reasonText } from '@/utils/format';
import { Badge } from '@/comps/ui/badge';
import { SignOut } from '@/app/dash/account/sign-out';
import { Page, PageHead } from '@/comps/frame/page-head';
import { Icon } from '@/comps/ui/icon';
import { Card } from '@/comps/ui/card';
import { NotifySwitch } from './notify';

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ComponentChildren;
}) {
  return (
    <div>
      <div class="label">
        <b>{label}</b>
        <span>{hint}</span>
      </div>
      <div class="value">{children}</div>
    </div>
  );
}

export default async function AccountPage({ request }: { request?: Request }) {
  if (!request) return null;
  try {
    const me = await load(request).me();
    const tokenMode = !me.user;
    const local = me.mode === 'local';
    const organization = me.organization;
    const name = organization?.name ?? organization?.slug ?? 'Local server';

    return (
      <Page>
        <PageHead
          title="Account"
          lead={
            tokenMode
              ? `This ${local ? 'local' : 'memory'} server keeps no accounts. The admin token is its only key.`
              : 'Who you are on this server and which workspace you act in.'
          }
        />
        <div class="sheet frame">
          <Row
            label={tokenMode ? 'Access' : 'Profile'}
            hint={
              tokenMode
                ? 'Accepted from loopback only, kept in a cookie.'
                : 'From the account you signed in with.'
            }
          >
            <span class="avatar">{me.user ? initial(me.user.name) : <Icon d={iKey} />}</span>
            <div class="grow">
              <b>{me.user ? me.user.name : 'Admin token'}</b>
              <span class="muted">
                {me.user ? me.user.email : local ? 'Local server' : 'Local memory server'}
              </span>
            </div>
          </Row>
          {local ? null : (
            <Row
              label="Workspace"
              hint="Agents, credentials, and tasks belong to it. Switch it from the menu at the top right."
            >
              <span class="avatar">{initial(name)}</span>
              <div class="grow">
                <b>{name}</b>
                {organization?.slug && organization.slug !== name ? (
                  <span class="muted">{organization.slug}</span>
                ) : null}
              </div>
              {organization?.role ? <Badge>{organization.role}</Badge> : null}
            </Row>
          )}
          <Row
            label="Notifications"
            hint="Toasts show in the dashboard either way. This also uses your browser's notifications."
          >
            <NotifySwitch />
          </Row>
          <Row
            label="Session"
            hint={
              tokenMode
                ? 'Forgetting the token signs this browser out until it is entered again.'
                : 'Signing out ends this browser session only.'
            }
          >
            {tokenMode ? (
              <form action="/dash/token" method="post">
                <input type="hidden" name="token" value="" />
                <input type="hidden" name="return" value="/dash" />
                <button class="btn outline">Forget token</button>
              </form>
            ) : (
              <SignOut class="btn secondary-danger">Sign out</SignOut>
            )}
          </Row>
        </div>
      </Page>
    );
  } catch (error) {
    return <LoadFailure error={error} />;
  }
}

function LoadFailure({ error }: { error: unknown }) {
  return (
    <Page>
      <PageHead title="Could not load this page" />
      <Card tone="danger">
        <p class="body prose">{reasonText(error)}</p>
      </Card>
    </Page>
  );
}
