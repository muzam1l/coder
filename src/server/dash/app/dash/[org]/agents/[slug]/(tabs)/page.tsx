import './page.css';
import { Fragment } from 'preact';
import { dynamic } from '@wular/pnext/dynamic';

import { formatDay, zoneOf } from '@/utils/format';
import { Button, LinkButton } from '@/comps/ui/button';
import { load, orgOf } from '@/api/load';
import type { AgentRow, VersionRow, Paged } from '@coder/client/types';
import { Card, Empty } from '@/comps/ui/card';
import { Settle } from '@/comps/frame/stream';
import { loadAgent } from '@/api/load';
import { editableAgent } from '@/api/types';
import { LIST_PAGE } from '@/utils/paged';
import { defaultLabel } from '@/app/dash/[org]/settings/model-options';
import type { Defaults } from '@/app/dash/[org]/tasks/composer';
import { DEFAULT_ENGINE } from '@coder/core/defaults';
import { NeedsCredential } from '@/app/dash/[org]/tasks/composer';
import { Notice } from '@/comps/ui/notice';
import { Icon } from '@/comps/ui/icon';
import { iAlert } from '@/comps/ui/icons';

const VersionsList = dynamic(() => import('./versions-list').then(m => m.VersionsList), {
  load: 'visible',
  ssr: true,
});

const Instructions = dynamic(() =>
  import('@/app/dash/[org]/agents/agent/instructions').then(m => m.Instructions),
);

const KIND: Record<string, string> = {
  builtin: 'Built-in agent',
  upload: 'Dashboard agent',
  repo: 'Repository agent',
  home: 'Local agent',
};

/** Why the agent answers no events, and where its definition is fixed. */
function NotRunning({ agent, org }: { agent: AgentRow; org: string }) {
  return (
    <Notice tone="error">
      <Icon d={iAlert} />
      <span class="grow">
        Not running until its definition is fixed.
        {agent.problems!.map(problem => (
          <Fragment key={problem}>
            <br />
            {problem}
          </Fragment>
        ))}
      </span>
      {editableAgent(agent) ? (
        <LinkButton
          variant="outline"
          size="sm"
          href="/dash/[org]/agents/[slug]/edit"
          params={{ org, slug: agent.id }}
          search={{ section: 'platforms' }}
        >
          Edit
        </LinkButton>
      ) : agent.source === 'repo' && agent.sourceUrl ? (
        <Button variant="outline" size="sm" href={agent.sourceUrl} external>
          Open in repository
        </Button>
      ) : (
        <LinkButton
          variant="outline"
          size="sm"
          href="/dash/[org]/agents/[slug]/settings"
          params={{ org, slug: agent.id }}
        >
          Settings
        </LinkButton>
      )}
    </Notice>
  );
}

/** Details, instructions and version history: the agent and its versions. */
function OverviewBody({
  agent,
  org,
  history,
  defaults,
  tz,
}: {
  agent: AgentRow;
  org: string;
  history: Paged<VersionRow>;
  defaults: Defaults;
  tz: string;
}) {
  const current = history.items.find(version => version.version === agent.currentVersion);
  const definition = agent.definition;
  const engine = agent.settings?.engine ?? definition?.engine;
  const base = engine ? defaults.engines[engine] : undefined;

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
            <dd>{engine ?? defaultLabel('first available engine')}</dd>
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
            <LinkButton
              variant="ghost"
              size="sm"
              href="/dash/[org]/agents/[slug]/edit"
              params={{ org, slug: agent.id }}
              search={{ section: 'instructions' }}
            >
              Edit
            </LinkButton>
          ) : agent.sourceUrl ? (
            <Button variant="ghost" size="sm" href={agent.sourceUrl} external>
              Open source
            </Button>
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
          <>
            {row.problems?.length ? <NotRunning agent={row} org={orgOf(request)} /> : null}
            {row.needsModel ? (
              <NeedsCredential reason="Agents need a model credential to run." label={row.name} />
            ) : null}
            <OverviewBody
              agent={row}
              org={orgOf(request)}
              history={history}
              defaults={{
                engine: shown?.effective.chain?.[0] ?? DEFAULT_ENGINE,
                engines: shown?.effective.engines ?? {},
              }}
              tz={tz}
            />
          </>
        ))
      }
    />
  );
}
