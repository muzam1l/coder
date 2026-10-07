'use client';

import type { ComponentChildren } from 'preact';

import { client } from '@/utils/client';
import { Link } from '@wular/pnext/link';
import { usePaged } from '@/utils/paged';
import type { AgentCardRow, IntegrationInfo, Paged } from '@coder/client/types';
import { Empty } from '@/comps/ui/card';
import { initial } from '@/utils/format';
import { AgentPills, BrandIcon, Platform } from '@/app/dash/agents/agent/agent-pills';
import { Menu, MenuRadio } from '@/comps/ui/menu';
import { Icon } from '@/comps/ui/icon';
import { NewAgentMenu } from './agent-menu';
import { Search, Toolbar, queryOf, useFilters } from '@/comps/ui/toolbar';
import { Tail } from '@/comps/ui/tail';

type Keys = 'q' | 'platform' | 'type';

function AgentCard({ agent, catalog }: { agent: AgentCardRow; catalog: IntegrationInfo[] }) {
  return (
    <li class="agent-card">
      <div class="bc-head">
        <span class="mark">{initial(agent.name)}</span>
        <div class="grow">
          <h3>
            <Link class="cover" href="/dash/agents/[slug]" params={{ slug: agent.id }}>
              {agent.name}
            </Link>
          </h3>
          <span class="pills">
            <AgentPills agent={agent} />
          </span>
        </div>
      </div>
      <div class="lead-clamp">
        <span>{agent.description ?? 'No description yet.'}</span>
      </div>
      {agent.platforms.length ? (
        <span class="pfs">
          {agent.platforms.map(platform => (
            <Platform
              key={platform.id}
              id={platform.id}
              info={catalog.find(entry => entry.id === platform.id)}
              state={platform.state}
            />
          ))}
        </span>
      ) : (
        <span class="pfs muted">Listens nowhere yet</span>
      )}
    </li>
  );
}

/** Every agent in pages, searched and filtered on the server. */
/** Agent kinds a list filters by. */
export const KINDS: Array<[string, string]> = [
  ['', 'All agents'],
  ['dashboard', 'Dashboard agents'],
  ['repository', 'Repository agents'],
  ['builtin', 'Built-in'],
];

export function AgentsGrid({
  first,
  limit,
  filters,
  catalog,
  head,
  children,
}: {
  first: Paged<AgentCardRow>;
  /** Agent cards per page. */
  limit: number;
  filters: Record<Keys, string>;
  catalog: IntegrationInfo[];
  head: { title: string; lead: string };
  /** What shows between the toolbar and the agents. */
  children?: ComponentChildren;
}) {
  const { values, set, query } = useFilters<Keys>(filters);
  const list = usePaged<AgentCardRow>({
    name: 'agents',
    fetchPage: cursor => client.agents.list({ cursor, limit, ...values }),
    query,
    first,
    initial: queryOf(filters),
  });

  return (
    <>
      <Toolbar head={head} action={<NewAgentMenu />}>
        <Search value={values.q} label="Search agents" onInput={value => set('q', value, 250)} />
        <Menu
          class="filter-more"
          label="More filters"
          summaryClass={`field-btn${values.platform || values.type ? ' on' : ''}`}
          summary="Filter"
        >
          <p class="pop-label">Platform</p>
          <div role="group" aria-label="Platform">
            <MenuRadio on={!values.platform} onPick={() => set('platform', '')}>
              All platforms
            </MenuRadio>
            {catalog.map(entry => (
              <MenuRadio
                key={entry.id}
                on={values.platform === entry.id}
                onPick={() => set('platform', entry.id)}
              >
                <span class="pf">
                  <BrandIcon brand={entry.brand} />
                  {entry.name}
                </span>
              </MenuRadio>
            ))}
          </div>
          <p class="pop-label">Source</p>
          <div role="group" aria-label="Source">
            {KINDS.map(([value, label]) => (
              <MenuRadio key={value} on={values.type === value} onPick={() => set('type', value)}>
                {label}
              </MenuRadio>
            ))}
          </div>
        </Menu>
      </Toolbar>
      {children}
      {list.rows.length ? (
        <ul class="agent-grid" aria-busy={list.stale}>
          {list.rows.map(agent => (
            <AgentCard key={agent.id} agent={agent} catalog={catalog} />
          ))}
        </ul>
      ) : list.stale ? null : (
        <Empty title="No agents match">Try another search or filter.</Empty>
      )}
      <Tail noun="agents" {...list} />
    </>
  );
}
