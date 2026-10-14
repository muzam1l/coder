'use client';

import './import-picker.css';

import { useEffect, useRef, useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { toastFailure, useAction } from '@/utils/action';
import { iGit } from '@/comps/ui/icons';
import { useRouter } from '@wular/pnext/navigation/client';
import { useOrg } from '@/comps/nav/org';
import { held } from '@/utils/paged';
import { Loading } from '@/comps/ui/card';
import { Icon } from '@/comps/ui/icon';
import { connectRepositories } from '@/app/dash/[org]/agents/editor/connect-repositories';
import { Search } from '@/comps/ui/toolbar';
import { TunnelGuide } from '@/app/dash/[org]/settings/tunnel-guide';
import { Notice } from '@/comps/ui/notice';

type Found = {
  id: string;
  name: string;
  description?: string;
  version?: number;
  commit?: string;
  taken?: boolean;
  warnings?: string[];
};
type Preview = { repo: string; agents?: Found[]; failed?: boolean };

const REPO = /^[\w.-]+\/[\w.-]+$/;
const short = (commit: string) => (/^[0-9a-f]{12,}$/i.test(commit) ? commit.slice(0, 7) : commit);

/** The agents a repository holds, ticked, and one Import; a push to the repository updates them. */
function Agents({ preview, onDone }: { preview: Preview; onDone: (ids: string[]) => void }) {
  const [off, setOff] = useState<Set<string>>(new Set());
  const action = useAction({ leaves: true });
  if (preview.failed) return null;
  if (!preview.agents) return <Loading label={`Reading ${preview.repo}`} h={180} />;
  if (!preview.agents.length)
    return (
      <p class="muted">
        {preview.repo} has no agents yet. Add a folder per agent under <code>.coder/agents</code>,
        with an <code>agent.json</code> and a <code>system.md</code>.
      </p>
    );
  const ticked = preview.agents
    .filter(agent => !agent.taken && !off.has(agent.id))
    .map(agent => agent.id);
  return (
    <form
      class="import-agents"
      onSubmit={async event => {
        event.preventDefault();
        if (!ticked.length) return;
        await action.run('import', async () =>
          onDone((await client.agents.import(preview.repo, undefined, ticked)).imported),
        );
      }}
    >
      <ul class="picks-list">
        {preview.agents.map(agent => (
          <li key={agent.id}>
            <label class="check">
              <input
                type="checkbox"
                checked={!agent.taken && !off.has(agent.id)}
                disabled={agent.taken}
                onChange={event => {
                  const next = new Set(off);
                  if (event.currentTarget.checked) next.delete(agent.id);
                  else next.add(agent.id);
                  setOff(next);
                }}
              />
              <span>
                <b>{agent.name}</b> <span class="id">{agent.id}</span>
                {agent.version ? (
                  <span class="badge">
                    v{agent.version}
                    {agent.commit ? ` · ${short(agent.commit)}` : ''}
                  </span>
                ) : null}
                <small>
                  {agent.taken
                    ? 'An agent with this id already exists here.'
                    : (agent.description ?? 'No description.')}
                </small>
                {agent.warnings?.map(warning => (
                  <small key={warning} role="status">
                    {warning}
                  </small>
                ))}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p class="muted">
        Each push to {preview.repo} that changes an agent publishes its new version here.
      </p>
      <div class="form-actions end">
        <button class="btn" disabled={Boolean(action.pending) || !ticked.length}>
          Import {ticked.length === 1 ? '1 agent' : `${ticked.length} agents`}
        </button>
      </div>
    </form>
  );
}

/** Pick a repository the connected platform reaches, or type one, then its agents. */
export function ImportPicker({
  connected,
  connectLabel,
  tunnel,
  port,
}: {
  connected: boolean;
  connectLabel: string;
  tunnel: boolean;
  port: string;
}) {
  const nav = useRouter();
  const org = useOrg();
  const [repos, setRepos] = useState<string[]>();
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<Preview>();
  const opened = useRef('');

  useEffect(() => {
    if (!connected) return;
    void client.repositories
      .list()
      .then(held(performance.now()))
      .then(rows => setRepos(rows.map(row => row.repo)))
      .catch(reason => {
        setRepos([]);
        toastFailure(reason);
      });
  }, []);

  const open = (repo: string) => {
    opened.current = repo;
    setPreview({ repo });
    void client.agents
      .preview(repo)
      .then(held(performance.now()))
      .then(({ agents }) => opened.current === repo && setPreview({ repo, agents }))
      .catch(reason => {
        if (opened.current !== repo) return;
        setPreview({ repo, failed: true });
        toastFailure(reason);
      });
  };
  const done = (ids: string[]) =>
    ids.length === 1
      ? nav.push('/dash/[org]/agents/[slug]', { params: { org, slug: ids[0]! } })
      : nav.push('/dash/[org]/agents', { params: { org } });

  const needle = query.trim().toLowerCase();
  const shown = (repos ?? []).filter(repo => repo.toLowerCase().includes(needle));
  const typed = REPO.test(query.trim()) && !repos?.includes(query.trim()) ? query.trim() : '';
  return (
    <div class="import">
      <div class="import-repos">
        {connected ? (
          <Search value={query} label="Search repositories or type owner/repo" onInput={setQuery} />
        ) : (
          <>
            <Notice>
              <Icon d={iGit} />
              <span class="grow">Connect to list your repositories here.</span>
              <button
                type="button"
                class="btn outline sm"
                onClick={() =>
                  void connectRepositories(`/dash/${org}/agents/new?template=import`).catch(
                    toastFailure,
                  )
                }
              >
                {connectLabel}
              </button>
            </Notice>
            <form
              class="with-btn"
              onSubmit={event => {
                event.preventDefault();
                if (REPO.test(query.trim())) open(query.trim());
              }}
            >
              <input
                class="mono"
                aria-label="Repository"
                placeholder="owner/repo"
                autocomplete="off"
                value={query}
                onInput={event => setQuery(event.currentTarget.value)}
              />
              <button class="btn outline">Look up</button>
            </form>
          </>
        )}
        {connected ? (
          <div class="repo-list scroll-box" role="list">
            {!repos ? (
              <Loading label="Loading repositories" h={240} />
            ) : (
              <>
                {typed ? (
                  <button
                    type="button"
                    class="pop-item"
                    aria-pressed={preview?.repo === typed}
                    onClick={() => open(typed)}
                  >
                    <Icon d={iGit} />
                    <span class="grow">{typed}</span>
                  </button>
                ) : null}
                {shown.map(repo => (
                  <button
                    key={repo}
                    type="button"
                    class="pop-item"
                    aria-pressed={preview?.repo === repo}
                    onClick={() => open(repo)}
                  >
                    <Icon d={iGit} />
                    <span class="grow">{repo}</span>
                  </button>
                ))}
                {!shown.length && !typed ? (
                  <p class="pop-note">No repository matches. Type owner/repo to use another.</p>
                ) : null}
              </>
            )}
          </div>
        ) : null}
        {!connected && tunnel ? <TunnelGuide port={port} /> : null}
      </div>
      <div class="import-preview">
        {preview ? (
          <>
            <h3>Agents in {preview.repo}</h3>
            <Agents key={preview.repo} preview={preview} onDone={done} />
          </>
        ) : (
          <p class="muted">Pick a repository to see the agents in its .coder/agents folder.</p>
        )}
      </div>
    </div>
  );
}
