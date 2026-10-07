import './page.css';
import { dynamic } from '@wular/pnext/dynamic';

import { formatDay, zoneOf } from '@/utils/format';
import { Link } from '@wular/pnext/link';
import { encodeDefinition, load, unwrap } from '@/api/load';
import type {
  AppRow,
  AgentRow,
  InstallationRow,
  IntegrationInfo,
  Reach,
} from '@coder/client/types';
import { Card, Empty } from '@/comps/ui/card';
import { Badge, Chips } from '@/comps/ui/badge';
import { MoreList } from '@/comps/ui/menu';
import { Settle } from '@/comps/frame/stream';
import { loadAgent } from '@/api/load';
import { needsTunnel } from '@/api/types';
import { editableAgent } from '@/api/types';
import { TunnelGuide } from '@/app/dash/settings/tunnel-guide';
import { Platform } from '@/app/dash/agents/agent/agent-pills';
import { Lead } from './loading';

const PlatformActions = dynamic(() => import('./platform-actions').then(m => m.PlatformActions));

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

/** Organizations this workspace already works in on `integration`, where a new app could live. */
const organizationsOn = (
  integration: string,
  catalog: IntegrationInfo[],
  everywhere: InstallationRow[],
) =>
  catalog.find(entry => entry.id === integration)?.organizationApps
    ? [
        ...new Set(
          everywhere
            .filter(
              entry =>
                entry.integration === integration &&
                entry.account.type &&
                entry.account.type !== 'User',
            )
            .map(entry => entry.account.login),
        ),
      ].sort()
    : [];

/** One row per platform: what wakes it, its access, the app, where it is installed, and the next step. */
function Platforms({
  agent,
  apps,
  installations,
  everywhere,
  catalog,
  tz,
}: {
  agent: AgentRow;
  apps: AppRow[];
  installations: InstallationRow[];
  everywhere: InstallationRow[];
  catalog: IntegrationInfo[];
  tz: string;
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
    <Card>
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
            {ids.map(id => {
              const own = apps.filter(app => app.integration === id);
              const installs = installations.filter(entry => own.some(app => app.id === entry.app));
              const state: Reach = !own.length ? 'none' : installs.length ? 'installed' : 'created';
              const narrowed = agent.settings?.integrations?.[id];
              const events = narrowed?.allowedEvents ?? eventNames(declared[id]?.triggers);
              const tools = narrowed?.allowedTools ?? declared[id]?.tools;
              const place = (entry: InstallationRow) => (
                <span key={entry.id} class="inst">
                  <b>{entry.account.login}</b>
                  <span class="sub">
                    {[
                      entry.account.type?.toLowerCase(),
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
                    <Platform id={id} info={catalog.find(entry => entry.id === id)} state={state} />
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
                    {own.length ? (
                      own.map(app => (
                        <span key={app.id} class="inst">
                          <b>{app.name}</b>
                          <span class="sub">created {formatDay(app.createdAt, tz)}</span>
                        </span>
                      ))
                    ) : (
                      <span class="muted">No app yet</span>
                    )}
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
                    ) : (
                      <span class="muted">{own.length ? 'Not installed' : 'Not available'}</span>
                    )}
                  </td>
                  <td class="acts">
                    <Badge tone={REACH_BADGE[state].tone}>{REACH_BADGE[state].label}</Badge>
                    <PlatformActions
                      integration={id}
                      apps={own.map(app => ({
                        id: app.id,
                        name: app.name,
                      }))}
                      installed={installs.length > 0}
                      createUrl={createUrl(id)}
                      owners={organizationsOn(id, catalog, everywhere)}
                    />
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
  const tz = zoneOf(request);
  const agent = loadAgent(request, slug);
  const apps = load(request).apps.list(slug).then(unwrap);
  const everywhere = load(request).installations.list().then(unwrap);
  const catalog = load(request)
    .integrations.list()
    .catch(() => []);
  const me = load(request)
    .me()
    .catch(() => undefined);
  const port = new URL(request.url).port || '8787';
  apps.catch(() => {});
  everywhere.catch(() => {});

  return (
    <>
      <Lead />
      <Settle
        load={() =>
          Promise.all([agent, apps, everywhere, catalog, me]).then(
            ([row, own, all, integrations, who]) => (
              <>
                <Platforms
                  agent={row}
                  apps={own}
                  installations={all.filter(
                    entry => !entry.deletedAt && own.some(app => app.id === entry.app),
                  )}
                  everywhere={all.filter(entry => !entry.deletedAt)}
                  catalog={integrations}
                  tz={tz}
                />
                {who && needsTunnel(who) ? <TunnelGuide port={port} /> : null}
              </>
            ),
          )
        }
      />
    </>
  );
}
