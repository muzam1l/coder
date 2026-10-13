import './page.css';
import { dynamic } from '@wular/pnext/dynamic';

import { Link } from '@wular/pnext/link';
import { encodeDefinition, load, unwrap } from '@/api/load';
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
import { InfoTip, MoreList } from '@/comps/ui/menu';
import { Settle } from '@/comps/frame/stream';
import { loadAgent } from '@/api/load';
import { needsTunnel } from '@/api/types';
import { editableAgent } from '@/api/types';
import { TunnelGuide } from '@/app/dash/settings/tunnel-guide';
import { Platform } from '@/app/dash/agents/agent/agent-pills';
import { Outcome, readOutcome, succeeded } from '@/app/dash/setup/outcome';
import { ConnectionsLine, Lead } from './loading';

const PlatformActions = dynamic(() => import('./platform-actions').then(m => m.PlatformActions));
const InstallButton = dynamic(() => import('./platform-actions').then(m => m.InstallButton));

/** Outcomes the person fixes by installing again. */
const RETRY = new Set(['cancelled', 'install-expired', 'platform-error', 'missing-code', 'failed']);

const eventNames = (events: unknown): string[] =>
  Array.isArray(events)
    ? events.map(String)
    : events && typeof events === 'object'
      ? Object.keys(events)
      : [];

const REACH_BADGE: Record<Reach, { tone?: 'ok' | 'warn'; label: string }> = {
  installed: { tone: 'ok', label: 'installed' },
  created: { tone: 'warn', label: 'app created' },
  none: { label: 'not set up' },
};

/** One row per platform: what wakes it, its access, the app, where it is installed, and the next step. */
function Platforms({
  agent,
  apps,
  installations,
  catalog,
  operator = false,
  failed,
}: {
  agent: AgentRow;
  apps: AppRow[];
  installations: InstallationRow[];
  catalog: IntegrationInfo[];
  /** The viewer runs this server and can set up its shared apps. */
  operator?: boolean;
  /** The last setup, when it failed unexpectedly. */
  failed?: SetupOutcome;
}) {
  const declared = agent.definition?.integrations ?? {};
  const ids = Object.keys(declared).sort();
  if (!ids.length)
    return (
      <Empty title="This agent listens nowhere yet">
        {editableAgent(agent) ? (
          <Link
            class="btn outline sm"
            href="/dash/agents/[slug]/edit"
            params={{ slug: agent.id }}
            search={{ section: 'platforms' }}
          >
            Pick a platform
          </Link>
        ) : (
          'Its definition declares no platform.'
        )}
      </Empty>
    );

  // Featured handles first, then the rest.
  const featured = (id: string) => catalog.some(entry => entry.id === id && entry.featured);
  const order = [...ids.filter(featured), ...ids.filter(id => !featured(id))];

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
    <Card title="Handles" count={ids.length}>
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
              const state: Reach = !own.length ? 'none' : installs.length ? 'installed' : 'created';
              const narrowed = agent.settings?.integrations?.[id];
              const events = narrowed?.allowedEvents ?? eventNames(declared[id]?.events);
              const tools = narrowed?.allowedTools ?? declared[id]?.tools;
              const place = (entry: InstallationRow) => (
                <span key={entry.id} class="inst">
                  <b>{entry.account.login}</b>
                  <span class="sub">
                    {[
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
                  <td class="muted">
                    {typeof tools === 'string'
                      ? tools
                      : Array.isArray(tools)
                        ? `${tools.length} tools`
                        : 'observe'}
                  </td>
                  <td>
                    {own.length
                      ? own.map(app => (
                          <span key={app.id} class="inst">
                            <b>{app.name}</b>
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
                    {builtin && !own.length && info?.builtinApp !== 'own' ? (
                      <>
                        <Badge>{REACH_BADGE.none.label}</Badge>
                        {operator ? (
                          <Link class="btn outline sm" href="/dash/operator">
                            Set up shared app
                          </Link>
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
                        <Badge tone={REACH_BADGE[state].tone}>{REACH_BADGE[state].label}</Badge>
                        <PlatformActions
                          integration={id}
                          name={info?.name ?? id}
                          apps={own.map(app => ({
                            id: app.id,
                            name: app.name,
                            public: app.public,
                            settingsUrl: app.settingsUrl,
                          }))}
                          installed={installs.length > 0}
                          createUrl={createUrl(id)}
                          create={info?.create}
                          unreachable={catalog.some(entry => entry.unreachable)}
                          publicApps={info?.publicApps}
                          organizationApps={info?.organizationApps}
                          shared={builtin && info?.builtinApp !== 'own'}
                          failed={
                            failed?.platform === id
                              ? { name: info?.name ?? id, app: failed.appId }
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
  // An unexpected failure opens a dialog on its platform's row instead.
  const failed = outcome?.status === 'failed' ? outcome : undefined;
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
            ([row, own, all, integrations, who]) => (
              <>
                {outcome &&
                !(failed?.platform && row.definition?.integrations?.[failed.platform]) ? (
                  <Outcome outcome={outcome} catalog={integrations}>
                    {succeeded(outcome) ? (
                      (outcome.connect ?? []).map(id => {
                        const app = appOn(own, id);
                        const name = integrations.find(entry => entry.id === id)?.name ?? id;
                        return app ? (
                          <InstallButton
                            key={id}
                            app={app.id}
                            link={outcome.link}
                            label={`Connect ${name} so the agent can act there`}
                          />
                        ) : null;
                      })
                    ) : RETRY.has(outcome.status) && retried(own) ? (
                      <InstallButton app={retried(own)!.id} label="Install again" />
                    ) : null}
                  </Outcome>
                ) : null}
                <Platforms
                  agent={row}
                  apps={own}
                  installations={all}
                  catalog={integrations}
                  operator={who?.operator === true}
                  failed={failed}
                />
                <ConnectionsLine />
                {(who && needsTunnel(who)) || integrations.some(entry => entry.unreachable) ? (
                  <div id="tunnel">
                    <TunnelGuide port={port} />
                  </div>
                ) : null}
              </>
            ),
          )
        }
      />
    </>
  );
}
