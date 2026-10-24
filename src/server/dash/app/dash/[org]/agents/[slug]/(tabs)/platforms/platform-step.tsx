'use client';

import './platform-step.css';

import type { IntegrationInfo, Reach } from '@coder/client/types';
import { reachOf, type Step } from './platform-state';
import { Badge } from '@/comps/ui/badge';
import { LinkButton } from '@/comps/ui/button';
import { InfoTip } from '@/comps/ui/menu';
import { PlatformActions } from './platform-actions';

const REACH_BADGE: Record<Reach, { tone?: 'ok' | 'warn'; label: string }> = {
  installed: { tone: 'ok', label: 'installed' },
  created: { tone: 'warn', label: 'app created' },
  none: { label: 'not set up' },
};

/** A platform's next step for an agent, the same on its Platforms tab and on Connections: set up the server's shared app, create the agent's own, install it, or manage its installs. */
export function PlatformStep({
  step,
  info,
  org,
  agent,
  builtin,
  operator,
  unreachable,
  failed,
  quiet,
}: {
  step: Step;
  info?: IntegrationInfo;
  org: string;
  /** The agent's id. */
  agent: string;
  /** The built-in agent, whose apps are the server's shared ones where the platform shares. */
  builtin: boolean;
  /** The viewer runs this server and can set up its shared apps. */
  operator: boolean;
  unreachable?: boolean;
  failed?: Parameters<typeof PlatformActions>[0]['failed'];
  /** No installed badge, where the row already shows the installed accounts. */
  quiet?: boolean;
}) {
  const { id } = step;
  const name = info?.name ?? id;
  const state = reachOf(step);
  const shared = builtin && info?.builtinApp !== 'own';

  if (!info)
    return (
      <span class="plat-step">
        <Badge>not offered</Badge>
        <InfoTip label={`Why ${id} is not offered`}>
          <p>
            This server does not offer {id}. Remove it from the agent's platforms, or ask whoever
            runs this server to add it.
          </p>
        </InfoTip>
      </span>
    );

  if (shared && !step.apps.length)
    return (
      <span class="plat-step">
        <Badge>{REACH_BADGE.none.label}</Badge>
        {operator ? (
          <LinkButton
            size="sm"
            href="/dash/[org]/operator"
            params={{ org }}
            search={{ setup: id }}
          >
            Set up shared app
          </LinkButton>
        ) : (
          <InfoTip label={`Why ${name} is not set up`}>
            <p>This server has no shared {name} app yet. Ask whoever runs this server to add one.</p>
          </InfoTip>
        )}
      </span>
    );

  return (
    <span class="plat-step">
      {step.gone ? (
        <Badge tone="warn">uninstalled</Badge>
      ) : (state === 'created' && shared) || (state === 'installed' && quiet) ? null : (
        // A shared app is never created by this workspace, only installed.
        <Badge tone={REACH_BADGE[state].tone}>{REACH_BADGE[state].label}</Badge>
      )}
      <PlatformActions
        agent={agent}
        integration={id}
        name={name}
        apps={step.apps}
        installed={step.live.length > 0}
        reinstall={step.gone}
        createUrl={step.createUrl}
        create={info.create}
        unreachable={unreachable}
        publicApps={info.publicApps}
        organizationApps={info.organizationApps}
        shared={shared}
        failed={failed}
      />
    </span>
  );
}
