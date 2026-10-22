'use client';

import './app-cards.css';

import type { AppCheck, AppRow, InstallationRow } from '@coder/client/types';
import { Card } from '@/comps/ui/card';
import { Badge, Chips } from '@/comps/ui/badge';
import { Button, LinkButton } from '@/comps/ui/button';
import { Row } from '@/app/dash/[org]/settings/[tab]/list';
import {
  CreateButton,
  InstallButton,
  RemoveButton,
  UninstallButton,
  UpdateButton,
  type CreateOptions,
} from '@/app/dash/[org]/agents/[slug]/(tabs)/platforms/platform-actions';

/** An app's installs, how it stays up to date, and removing it; a shared app's own actions are only the operator's. */
export function AppCards({
  org,
  slug,
  app,
  installs,
  events,
  covered,
  admin,
  operator,
  appUpdate,
  check,
  asked,
  create,
}: {
  org: string;
  slug: string;
  app: AppRow;
  installs: InstallationRow[];
  /** What wakes the agent here. */
  events: string[];
  /** What one install covers, such as a repository. */
  covered: string;
  /** The viewer owns or administers this workspace. */
  admin: boolean;
  /** The viewer runs this server. */
  operator: boolean;
  appUpdate?: 'push' | 'drift' | 'confirm';
  /** What to change on the platform, read for a chat's `?update=1` link. */
  check?: AppCheck;
  /** A chat's `?delete=` link opens Remove. */
  asked: boolean;
  create: CreateOptions;
}) {
  const { name } = create;
  const live = installs.filter(entry => !entry.uninstalled);
  const manages = admin && !app.builtin;
  const kind = (entry: InstallationRow) =>
    [
      entry.account.type?.toLowerCase() ?? 'account',
      entry.covers && `${entry.covers.length} ${covered}${entry.covers.length === 1 ? '' : 's'}`,
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <div class="app-cards">
      <Card
        title="Installed on"
        count={live.length}
        actions={
          <InstallButton
            app={app.id}
            label={live.length ? 'Install on another account' : 'Install'}
            variant="outline"
            size="sm"
          />
        }
      >
        {installs.length ? (
          <div class="table-scroll">
            <table class="rows settings">
              <tbody>
                {live.map(entry => (
                  <Row
                    key={entry.id}
                    title={entry.account.login}
                    sub={kind(entry)}
                    actions={
                      admin ? (
                        <UninstallButton
                          install={{ id: entry.id, app: app.name, account: entry.account.login }}
                          name={name}
                        />
                      ) : null
                    }
                  />
                ))}
                {installs
                  .filter(entry => entry.uninstalled)
                  .map(entry => (
                    <Row
                      key={entry.id}
                      muted
                      title={entry.account.login}
                      badges={<Badge>uninstalled</Badge>}
                      sub={kind(entry)}
                      actions={
                        <InstallButton app={app.id} label="Reinstall" variant="outline" size="sm" />
                      }
                    />
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p class="body muted">Not installed on any {name} account yet.</p>
        )}
      </Card>
      <Card title="App">
        <div class="table-scroll">
          <table class="rows settings">
            <tbody>
              <Row
                title={`Settings on ${name}`}
                sub={
                  app.builtin
                    ? `This server's shared app. Only whoever runs this server changes it.`
                    : app.changed
                      ? 'The agent changed since the app was last updated.'
                      : undefined
                }
                actions={
                  <>
                    {manages && appUpdate ? (
                      <UpdateButton app={app} name={name} appUpdate={appUpdate} check={check} />
                    ) : null}
                    {app.builtin && operator ? (
                      <LinkButton
                        variant="outline"
                        size="sm"
                        href="/dash/[org]/operator"
                        params={{ org }}
                      >
                        Open Operator
                      </LinkButton>
                    ) : null}
                    {app.settingsUrl ? (
                      <Button variant="outline" size="sm" href={app.settingsUrl} external>
                        Open app settings
                      </Button>
                    ) : null}
                  </>
                }
              />
              <Row
                title="Events"
                sub={events.length ? <Chips values={events} /> : 'None'}
                actions={
                  <LinkButton
                    variant="outline"
                    size="sm"
                    href="/dash/[org]/agents/[slug]/settings"
                    params={{ org, slug }}
                  >
                    Change in Settings
                  </LinkButton>
                }
              />
              {manages ? (
                <Row
                  title={`Another ${name} app`}
                  sub="A separate app with its own name, for the same agent."
                  actions={<CreateButton {...create} />}
                />
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
      {manages ? (
        <Card tone="danger" title="Danger zone">
          <div class="table-scroll">
            <table class="rows settings">
              <tbody>
                <Row
                  title="Remove app"
                  sub={`Coder forgets this app and its installs. It stays on ${name} until you delete it there.`}
                  actions={<RemoveButton app={app} name={name} asked={asked} />}
                />
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
