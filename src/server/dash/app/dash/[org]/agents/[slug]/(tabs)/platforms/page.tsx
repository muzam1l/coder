import './page.css';
import { dynamic } from '@wular/pnext/dynamic';

import { encodeDefinition, load, orgOf, unwrap } from '@/api/load';
import type {
  AppRow,
  AgentRow,
  InstallationRow,
  IntegrationInfo,
  Reach,
  SetupOutcome,
} from '@coder/client/types';
import { Card, Empty } from '@/comps/ui/card';
import { Badge, Chips } from '@/comps/ui/badge';
import { Button, LinkButton } from '@/comps/ui/button';
import { Icon } from '@/comps/ui/icon';
import { iAlert } from '@/comps/ui/icons';
import { InfoTip, MoreList } from '@/comps/ui/menu';
import { Settle } from '@/comps/frame/stream';
import { loadAgent } from '@/api/load';
import { needsTunnel } from '@/api/types';
import { editableAgent, eventNames } from '@/api/types';
import { TunnelGuide } from '@/app/dash/[org]/settings/tunnel-guide';
import { Platform } from '@/app/dash/[org]/agents/agent/agent-pills';
import {
  outcomeName,
  outcomeText,
  outcomeTitle,
  readOutcome,
  succeeded,
} from '@/app/dash/[org]/setup/outcome';
import { ConnectionsLine, Lead } from './loading';
import { Notice } from '@/comps/ui/notice';
import { NeedsCredential } from '@/app/dash/[org]/tasks/composer';
import { CredentialsLink } from '@/comps/nav/back';

const PlatformActions = dynamic(() => import('./platform-actions').then(m => m.PlatformActions));
const InstallButton = dynamic(() => import('./platform-actions').then(m => m.InstallButton));
const DriftQueue = dynamic(() => import('./platform-actions').then(m => m.DriftQueue));
const OutcomeDialog = dynamic(() =>
  import('@/app/dash/[org]/setup/outcome-dialog').then(m => m.OutcomeDialog),
);

/** Outcomes the person fixes by installing again. */
const RETRY = new Set(['cancelled', 'install-expired', 'platform-error', 'missing-code', 'failed']);

const REACH_BADGE: Record<Reach, { tone?: 'ok' | 'warn'; label: string }> = {
  installed: { tone: 'ok', label: 'installed' },
  created: { tone: 'warn', label: 'app created' },
  none: { label: 'not set up' },
};

/** One row per platform: what wakes it, its access, the app, where it is installed, and the next step. */
function Platforms({
  agent,
  org,
  apps,
  installations,
  catalog,
  operator = false,
  failed,
  issues,
}: {
  agent: AgentRow;
  org: string;
  apps: AppRow[];
  installations: InstallationRow[];
  catalog: IntegrationInfo[];
  /** The viewer runs this server and can set up its shared apps. */
  operator?: boolean;
  /** The last setup, when it failed unexpectedly. */
  failed?: SetupOutcome;
  /** Where to report an unexpected failure. */
  issues?: string;
}) {
  const declared = agent.definition?.integrations ?? {};
  const readOnly = agent.definition?.access === 'read' || agent.settings?.access === 'read';
  const ids = Object.keys(declared).sort();
  if (!ids.length)
    return (
      <Empty title="This agent listens nowhere yet">
        {editableAgent(agent) ? (
          <LinkButton
            variant="outline"
            size="sm"
            href="/dash/[org]/agents/[slug]/edit"
            params={{ org, slug: agent.id }}
            search={{ section: 'platforms' }}
          >
            Pick a platform
          </LinkButton>
        ) : (
          'Its definition declares no platform.'
        )}
      </Empty>
    );

  // In catalog order; a platform the catalog lacks goes last.
  const position = (id: string) => {
    const index = catalog.findIndex(entry => entry.id === id);
    return index < 0 ? catalog.length : index;
  };
  const order = [...ids].sort((a, b) => position(a) - position(b));

  const builtin = agent.source === 'builtin';
  const def = agent.definition ? encodeDefinition(agent.definition) : '';
  const createUrl = (integration: string) => {
    const params = new URLSearchParams({ agent: agent.id, def });
    if (agent.source === 'repo' && agent.repo) {
      params.set('repo', agent.repo);
      params.set('branch', apps.find(app => app.branch)?.branch ?? 'main');
    }
    return `/create/${encodeURIComponent(integration)}?${params}`;
  };

  return (
    <Card title="Handles" count={order.filter(id => catalog.some(entry => entry.id === id)).length}>
      <div class="table-scroll">
        <table class="plat stacked early">
          <thead>
            <tr>
              <th>Platform</th>
              <th>Wakes on</th>
              <th>Access</th>
              <th>App</th>
              <th>Installed on</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {order.map(id => {
              const info = catalog.find(entry => entry.id === id);
              const own = apps.filter(app => app.integration === id);
              const installs = installations.filter(entry => own.some(app => app.id === entry.app));
              const live = installs.filter(entry => !entry.uninstalled);
              const state: Reach = !own.length ? 'none' : live.length ? 'installed' : 'created';
              // Every install was removed on the platform; Reinstall puts the first back.
              const gone = live.length ? undefined : installs[0];
              const narrowed = agent.settings?.integrations?.[id];
              const events = narrowed?.allowedEvents ?? eventNames(declared[id]?.events);
              const place = (entry: InstallationRow) => (
                <span key={entry.id} class="inst">
                  {entry.account.url ? (
                    <a href={entry.account.url} target="_blank" rel="noreferrer">
                      <b>{entry.account.login}</b>
                    </a>
                  ) : (
                    <b>{entry.account.login}</b>
                  )}
                  <span class="sub">
                    {[
                      entry.uninstalled && 'uninstalled',
                      entry.account.type?.toLowerCase(),
                      entry.covers &&
                        `${entry.covers.length} ${info?.covered ?? 'account'}${entry.covers.length === 1 ? '' : 's'}`,
                      [entry.settings?.configRepo, entry.settings?.engine, entry.settings?.effort]
                        .filter(Boolean)
                        .join(', '),
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'account'}
                  </span>
                </span>
              );
              return (
                <tr key={id}>
                  <td>
                    <Platform id={id} info={info} state={state} />
                  </td>
                  <td>
                    <Chips values={events} />
                  </td>
                  <td class="muted">{readOnly ? 'Read-only' : 'Read-write'}</td>
                  <td>
                    {own.length
                      ? own.map(app => (
                          <span key={app.id} class="inst">
                            {app.settingsUrl ? (
                              <a href={app.settingsUrl} target="_blank" rel="noreferrer">
                                <b>{app.name}</b>
                              </a>
                            ) : (
                              <b>{app.name}</b>
                            )}
                            {events.includes('mention') ? (
                              <span class="sub">mention @{app.name}</span>
                            ) : null}
                          </span>
                        ))
                      : null}
                  </td>
                  <td class="where">
                    {installs.length ? (
                      <>
                        {installs.slice(0, 2).map(place)}
                        {installs.length > 2 ? (
                          <MoreList label={`+${installs.length - 2} more`}>
                            {installs.slice(2).map(place)}
                          </MoreList>
                        ) : null}
                      </>
                    ) : own.length ? (
                      <span class="muted">Not installed</span>
                    ) : null}
                  </td>
                  <td class="acts">
                    {!info ? (
                      <>
                        <Badge>not offered</Badge>
                        <InfoTip label={`Why ${id} is not offered`}>
                          <p>
                            This server does not offer {id}. Remove it from the agent's platforms,
                            or ask whoever runs this server to add it.
                          </p>
                        </InfoTip>
                      </>
                    ) : builtin && !own.length && info.builtinApp !== 'own' ? (
                      <>
                        <Badge>{REACH_BADGE.none.label}</Badge>
                        {operator ? (
                          <LinkButton
                            variant="outline"
                            size="sm"
                            href="/dash/[org]/operator"
                            params={{ org }}
                          >
                            Set up shared app
                          </LinkButton>
                        ) : (
                          <InfoTip label={`Why ${info?.name ?? id} is not set up`}>
                            <p>
                              This server has no shared {info?.name ?? id} app yet. Ask whoever runs
                              this server to add one.
                            </p>
                          </InfoTip>
                        )}
                      </>
                    ) : (
                      <>
                        {gone ? (
                          <Badge tone="warn">uninstalled</Badge>
                        ) : (
                          <Badge tone={REACH_BADGE[state].tone}>{REACH_BADGE[state].label}</Badge>
                        )}
                        <PlatformActions
                          integration={id}
                          name={info?.name ?? id}
                          apps={own.map(app => ({
                            id: app.id,
                            name: app.name,
                            settingsUrl: app.settingsUrl,
                            changed: app.changed,
                          }))}
                          installed={live.length > 0}
                          reinstall={gone?.app}
                          createUrl={createUrl(id)}
                          create={info?.create}
                          unreachable={catalog.some(entry => entry.unreachable)}
                          publicApps={info?.publicApps}
                          organizationApps={info?.organizationApps}
                          shared={builtin && info.builtinApp !== 'own'}
                          appUpdate={info.appUpdate}
                          failed={
                            failed?.platform === id
                              ? {
                                  name: info?.name ?? id,
                                  app: failed.appId,
                                  issues,
                                  ...(failed.status === 'failed'
                                    ? {}
                                    : {
                                        title: outcomeTitle(failed, info?.name ?? id),
                                        text: outcomeText(failed, info?.name ?? id),
                                      }),
                                }
                              : undefined
                          }
                        />
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default async function AgentPlatformsPage({
  request,
  params,
}: {
  request?: Request;
  params: Promise<Record<string, string | string[]>>;
}) {
  if (!request) return null;
  const { slug: raw } = await params;
  const slug = Array.isArray(raw) ? raw[0]! : raw!;
  const agent = loadAgent(request, slug);
  const apps = load(request).apps.list(slug).then(unwrap);
  const installations = load(request)
    .installations.list(slug, { limit: 200, active: true })
    .then(unwrap);
  const catalog = load(request)
    .integrations.list(slug)
    .catch(() => []);
  const me = load(request)
    .me()
    .catch(() => undefined);
  const port = new URL(request.url).port || '8787';
  const outcome = readOutcome(new URL(request.url).searchParams);
  // A failure worth retrying opens a dialog on its platform's row, where Try again lives.
  const failed = outcome && RETRY.has(outcome.status) ? outcome : undefined;
  // Apps a publish left needing changes on their platform.
  const updates = new URL(request.url).searchParams.get('update')?.split(',') ?? [];
  const appOn = (apps: AppRow[], integration?: string) =>
    apps.find(app => app.integration === integration);
  const retried = (apps: AppRow[]) =>
    apps.find(app => app.id === outcome?.appId) ?? appOn(apps, outcome?.platform);
  apps.catch(() => {});
  installations.catch(() => {});

  return (
    <>
      <Lead />
      <Settle
        load={() =>
          Promise.all([agent, apps, installations, catalog, me]).then(
            ([row, own, all, integrations, who]) => {
              // A failure opens on its row when the row has actions; a shared app not set up here has none.
              const inRow =
                failed?.platform &&
                row.definition?.integrations?.[failed.platform] &&
                !(
                  row.source === 'builtin' &&
                  !appOn(own, failed.platform) &&
                  integrations.find(entry => entry.id === failed.platform)?.builtinApp !== 'own'
                );
              const entry = integrations.find(item => item.id === outcome?.platform);
              const connected =
                outcome?.status === 'connected' && entry
                  ? {
                      platform: entry.name,
                      ready: !row.needsModel,
                      next: !row.needsModel
                        ? (entry.use ?? '').replace(
                            '{handle}',
                            appOn(own, entry.id)?.name ?? row.name,
                          )
                        : `Add a model so ${row.name} can start working.`,
                      url: all.find(
                        item =>
                          item.integration === entry.id && item.account.login === outcome.account,
                      )?.account.url,
                    }
                  : undefined;
              const queued = own
                .filter(app => updates.includes(app.id))
                .map(app => ({
                  id: app.id,
                  name: app.name,
                  platform:
                    integrations.find(entry => entry.id === app.integration)?.name ??
                    app.integration,
                }));

              return (
                <>
                  {row.needsModel ? (
                    <NeedsCredential
                      reason="Agents need a model credential to run."
                      label={row.name}
                    />
                  ) : null}
                  {outcome && !inRow ? (
                    <OutcomeDialog
                      ok={succeeded(outcome)}
                      title={outcomeTitle(outcome, outcomeName(outcome, integrations))}
                      text={
                        connected
                          ? [outcomeText(outcome, connected.platform), connected.next]
                              .filter(Boolean)
                              .join(' ')
                          : outcomeText(outcome, outcomeName(outcome, integrations))
                      }
                      issues={who?.server?.issuesUrl}
                      {...(connected ? { cancel: 'Connect more' } : {})}
                    >
                      {connected?.ready && connected.url ? (
                        <Button href={connected.url} external>
                          Open {connected.platform}
                        </Button>
                      ) : null}
                      {connected && !connected.ready ? (
                        <CredentialsLink label={row.name}>Add a model</CredentialsLink>
                      ) : null}
                      {RETRY.has(outcome.status) && retried(own) ? (
                        <InstallButton app={retried(own)!.id} label="Install again" />
                      ) : null}
                    </OutcomeDialog>
                  ) : null}
                  {queued.length ? <DriftQueue apps={queued} /> : null}
                  <Platforms
                    agent={row}
                    org={orgOf(request)}
                    apps={own}
                    installations={all}
                    catalog={integrations}
                    operator={who?.operator === true}
                    failed={inRow ? failed : undefined}
                    issues={who?.server?.issuesUrl}
                  />
                  {row.deliveries ? (
                    <Notice tone="error" slim>
                      <Icon d={iAlert} />
                      <span class="grow">
                        {row.deliveries.failed === 1
                          ? '1 delivery failed in the last day.'
                          : `${row.deliveries.failed} deliveries failed in the last day.`}
                      </span>
                      <LinkButton
                        variant="outline"
                        size="sm"
                        href="/dash/[org]/agents/[slug]/usage"
                        params={{ org: orgOf(request), slug: row.id }}
                        hash="deliveries"
                      >
                        View deliveries
                      </LinkButton>
                    </Notice>
                  ) : null}
                  <ConnectionsLine />
                  {(who && needsTunnel(who)) || integrations.some(entry => entry.unreachable) ? (
                    <div id="tunnel">
                      <TunnelGuide port={port} />
                    </div>
                  ) : null}
                </>
              );
            },
          )
        }
      />
    </>
  );
}
