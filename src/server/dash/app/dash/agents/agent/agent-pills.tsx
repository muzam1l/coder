import './agent-pills.css';
import { useId } from 'preact/hooks';
import { iGit } from '@/comps/ui/icons';
import type { IntegrationInfo, Reach } from '@coder/client/types';
import { Badge } from '@/comps/ui/badge';
import { Icon } from '@/comps/ui/icon';

const REACH_TEXT: Record<Reach, string> = {
  installed: 'installed',
  created: 'app created, not installed yet',
  none: 'no app yet',
};

/** Official marks carry gradient ids; each copy on a page gets its own so they never shadow one another. */
const scoped = (svg: string, suffix: string) =>
  svg
    .replace(/\bid="([^"]+)"/g, `id="$1${suffix}"`)
    .replace(/url\(#([^)]+)\)/g, `url(#$1${suffix})`)
    .replace(/href="#([^"]+)"/g, `href="#$1${suffix}"`);

export function BrandIcon({ brand }: { brand: IntegrationInfo['brand'] }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  if (brand.svg)
    return (
      <span
        class="brand-icon"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: scoped(brand.svg, `-${uid}`) }}
      />
    );

  return (
    <svg
      class="brand-icon"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      style={{ color: brand.dark ? `light-dark(${brand.color}, ${brand.dark})` : brand.color }}
    >
      <path d={brand.icon} />
    </svg>
  );
}

export function Platform({
  id,
  info,
  state,
}: {
  id: string;
  info?: IntegrationInfo;
  state: Reach;
}) {
  const name = info?.name ?? id;
  return (
    <span class={`pf ${state}`} title={`${name}, ${REACH_TEXT[state]}`} data-s={REACH_TEXT[state]}>
      {info ? <BrandIcon brand={info.brand} /> : null}
      {name}
    </span>
  );
}

const AGENT_KIND: Record<string, string> = {
  builtin: 'built-in',
  upload: 'dashboard',
  repo: 'repository',
  home: 'local',
};

/** Built-in, dashboard, or the repository it comes from, plus the version. */
export function AgentPills({
  agent,
}: {
  agent: {
    source: string;
    repo?: string;
    sourceUrl?: string;
    currentVersion: number;
    local?: true;
    commit?: string;
  };
}) {
  return (
    <>
      {agent.source === 'repo' && agent.repo ? (
        agent.sourceUrl ? (
          <a
            class="badge link-pill"
            href={agent.sourceUrl}
            target="_blank"
            rel="noreferrer"
            title={`Repository agent, opens ${agent.repo}`}
          >
            <Icon d={iGit} />
            {agent.repo}
          </a>
        ) : (
          <span class="badge link-pill" title="Repository agent">
            <Icon d={iGit} />
            {agent.repo}
          </span>
        )
      ) : (
        <Badge
          title={
            agent.local && agent.source === 'repo'
              ? 'Repo agent, a folder in this repository'
              : agent.source === 'home'
                ? 'Local agent, a folder on this machine'
                : agent.source !== 'upload'
                  ? 'Ships with Coder'
                  : agent.local
                    ? 'Local agent, a folder on this machine'
                    : 'Dashboard agent, made and edited here'
          }
        >
          {agent.local && agent.source === 'upload'
            ? 'local'
            : (AGENT_KIND[agent.source] ?? agent.source)}
        </Badge>
      )}
      {agent.local ? (
        agent.commit && (
          <Badge title="Last commit of the agent's folder">{agent.commit.slice(0, 7)}</Badge>
        )
      ) : (
        <Badge>v{agent.currentVersion}</Badge>
      )}
    </>
  );
}
