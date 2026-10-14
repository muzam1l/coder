import './hero.css';
import type { ComponentChildren } from 'preact';

import { BLANK } from '@/comps/frame/loading-card';
import type { AgentRow } from '@coder/client/types';
import { initial } from '@/utils/format';
import { AgentPills } from '@/app/dash/[org]/agents/agent/agent-pills';
import { AgentToggle } from '@/app/dash/[org]/agents/agent/agent-toggle';
import { MoreList } from '@/comps/ui/menu';
import { Sentinel } from '@/comps/ui/sentinel';

/** Handles shown before the rest fold behind +N more. */
const SHOWN = 2;

const handleLine = ({ name, platform }: { name: string; platform: string }) => (
  <li key={`${platform} ${name}`}>
    <b>@{name}</b> on {platform}
  </li>
);

/** An agent's hero before its record arrives: the same lines, blank, so what it shows lands in place. */
export function LoadingHero({
  actions,
  back,
}: {
  actions?: ComponentChildren;
  back?: ComponentChildren;
}) {
  return (
    <header class="hero">
      <span class="hero-mark" />
      <div class="grow">
        {back}
        <div class="title-row">
          <h1>{BLANK}</h1>
        </div>
        <p class="lead">{BLANK}</p>
      </div>
      {actions ? (
        <div class="hero-side">
          <div class="actions">{actions}</div>
        </div>
      ) : null}
    </header>
  );
}

export function Hero({
  agent,
  actions,
  back,
}: {
  agent: AgentRow;
  actions?: ComponentChildren;
  /** A `Back` link on its own line above the title. */
  back?: ComponentChildren;
}) {
  return (
    <>
      <Sentinel />
      <header class="hero">
        <span class="hero-mark">{initial(agent.name)}</span>
        <div class="grow">
          {back}
          <div class="title-row">
            <h1>{agent.name}</h1>
            <AgentPills agent={agent} />
            {agent.settings?.disabled ? <AgentToggle agent={agent} class="link" /> : null}
          </div>
          <p class="lead">{agent.description ?? 'No description yet.'}</p>
        </div>
        {actions || agent.handles?.length ? (
          <div class="hero-side">
            {actions ? <div class="actions">{actions}</div> : null}
            {agent.handles?.length ? (
              <ul class="handles" title="Mention it on its platforms by these names">
                {agent.handles.slice(0, SHOWN).map(handleLine)}
                {agent.handles.length > SHOWN ? (
                  <li>
                    <MoreList label={`+${agent.handles.length - SHOWN} more`}>
                      <ul class="handles">{agent.handles.slice(SHOWN).map(handleLine)}</ul>
                    </MoreList>
                  </li>
                ) : null}
              </ul>
            ) : null}
          </div>
        ) : null}
      </header>
    </>
  );
}
