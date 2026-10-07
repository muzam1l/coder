import './page.css';
import { dynamic } from '@wular/pnext/dynamic';

import { formatDay, zoneOf } from '@/utils/format';
import { Link } from '@wular/pnext/link';
import { load } from '@/api/load';
import type { AgentRow, VersionRow, Paged } from '@coder/client/types';
import { Card, Empty } from '@/comps/ui/card';
import { Settle } from '@/comps/frame/stream';
import { loadAgent } from '@/api/load';
import { editableAgent } from '@/api/types';
import { LIST_PAGE } from '@/utils/paged';
import { ENGINE_NAMES, defaultLabel } from '@/app/dash/settings/model-options';
import type { Defaults } from '@/app/dash/tasks/composer';

const VersionsList = dynamic(() => import('./versions-list').then(m => m.VersionsList), {
  load: 'visible',
  ssr: true,
});

const Instructions = dynamic(() =>
  import('@/app/dash/agents/agent/instructions').then(m => m.Instructions),
);

const KIND: Record<string, string> = {
  builtin: 'Built-in agent',
  upload: 'Dashboard agent',
  repo: 'Repository agent',
  home: 'Local agent',
};

/** Details, instructions and version history: the agent and its versions. */
function OverviewBody({
  agent,
  history,
  defaults,
  tz,
}: {
  agent: AgentRow;
  history: Paged<VersionRow>;
  defaults: Defaults;
  tz: string;
}) {
  const current = history.items.find(version => version.version === agent.currentVersion);
  const definition = agent.definition;
  const engine = agent.settings?.engine ?? definition?.engine;
  const base = defaults.engines[engine ?? defaults.engine];

  return (
    <>
      <Card title="Details">
        <dl class="facts body">
          <div>
            <dt>Type</dt>
            <dd>
              {agent.local && agent.source === 'repo'
                ? 'Repo agent'
                : agent.local && agent.source === 'upload'
                  ? 'Local agent'
                  : (KIND[agent.source] ?? agent.source)}
            </dd>
          </div>
          <div>
            <dt>Engine</dt>
            <dd>{engine ?? defaultLabel(ENGINE_NAMES[defaults.engine] ?? defaults.engine)}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{agent.settings?.model ?? definition?.model ?? defaultLabel(base?.model)}</dd>
          </div>
          <div>
            <dt>Effort</dt>
            <dd>{agent.settings?.effort ?? definition?.effort ?? defaultLabel(base?.effort)}</dd>
          </div>
          <div>
            <dt>Permissions</dt>
            <dd>
              {agent.settings?.permissions ?? definition?.permissions ?? defaultLabel('read-only')}
            </dd>
          </div>
          {agent.local ? (
            agent.commit && (
              <div>
                <dt>Commit</dt>
                <dd>{agent.commit.slice(0, 7)}</dd>
              </div>
            )
          ) : (
            <div>
              <dt>Version</dt>
              <dd>
                v{agent.currentVersion}
                {current ? `, ${formatDay(current.createdAt, tz)}` : ''}
              </dd>
            </div>
          )}
        </dl>
      </Card>
      <Card
        title="Instructions"
        actions={
          editableAgent(agent) ? (
            <Link
              class="btn ghost sm"
              href="/dash/agents/[slug]/edit"
              params={{ slug: agent.id }}
              search={{ section: 'instructions' }}
            >
              Edit
            </Link>
          ) : agent.sourceUrl ? (
            <a class="btn ghost sm" href={agent.sourceUrl} target="_blank" rel="noreferrer">
              Open source
            </a>
          ) : undefined
        }
      >
        {agent.systemPrompt?.trim() ? (
          <Instructions text={agent.systemPrompt.trim()} />
        ) : (
          <Empty title="No instructions yet">
            The agent starts every task from a blank prompt.
          </Empty>
        )}
      </Card>
      {agent.local ? null : (
        <Card title="Version history" count={agent.currentVersion}>
          <p class="body muted">
            Each publish adds a version. New tasks run on the current one, and the list shows when
            each went live.
          </p>
          <VersionsList agent={agent.id} current={agent.currentVersion} first={history} tz={tz} />
        </Card>
      )}
    </>
  );
}

export default async function AgentPage({
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
  const versions = load(request).agents.versions(slug, { cursor: '', limit: LIST_PAGE });
  const config = load(request)
    .config.get()
    .catch(() => undefined);

  return (
    <Settle
      load={() =>
        Promise.all([agent, versions, config]).then(([row, history, shown]) => (
          <OverviewBody
            agent={row}
            history={history}
            defaults={{
              engine: shown?.effective.chain?.[0] ?? 'claude',
              engines: shown?.effective.engines ?? {},
            }}
            tz={tz}
          />
        ))
      }
    />
  );
}
