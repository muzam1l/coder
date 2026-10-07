import './hero.css';
import type { ComponentChildren } from 'preact';

import { BLANK } from '@/comps/frame/loading-card';
import type { AgentRow } from '@coder/client/types';
import { initial } from '@/utils/format';
import { AgentPills } from '@/app/dash/agents/agent/agent-pills';
import { Sentinel } from '@/comps/ui/sentinel';

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
      {actions ? <div class="actions">{actions}</div> : null}
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
          </div>
          <p class="lead">{agent.description ?? 'No description yet.'}</p>
        </div>
        {actions ? <div class="actions">{actions}</div> : null}
      </header>
    </>
  );
}
