/** Agents that live in a repository: reading it through an installed app, importing its versions, and loading one app's agent. */
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';

import { agentsFromSources, assertNotReserved, loadAgents } from '../../agent/load';
import { INTEGRATIONS, repositoryReader } from '../../integrations';
import type { Integration } from '../../integrations/types';
import type { Agent, AgentApp, AgentEvent, AgentUsage, Installation } from '../../agent/types';
import type { AgentVersionRecord, Store } from '../store/types';
import type { ServerConfig, ServerContext } from '../context';
import { decryptSecret, encryptSecret } from '../store/secrets';
import { agentWithVersion, getVersion, publishVersion, seedBuiltinAgent, toAgent } from './records';

export type Contents = Integration & Required<Pick<Integration, 'repos'>>;

export const AGENTS_DIR = '.coder/agents';
const CONFIG_FILE = '.coder/config.json';
const USAGE_TTL_MS = 60_000;

function eventRepo(event: AgentEvent): string | undefined {
  return event.repo ? `${event.repo.owner}/${event.repo.name}` : undefined;
}

async function readUsage(
  contents: Contents,
  repo: string,
  token: string,
  ref?: string,
): Promise<unknown> {
  const config = await contents.repos.readFile(repo, CONFIG_FILE, token, ref);
  return config === undefined ? undefined : (JSON.parse(config) as { agents?: unknown }).agents;
}

export interface RepositoryAccess {
  contents: Contents;
  token: string;
  app?: AgentApp;
  installation?: Installation;
}

/** Find repository contents access from resolved tokens or an installed app that owns the repo. */
async function repositoryAccess(
  integrations: Record<string, Integration>,
  options: { config: Pick<ServerConfig, 'encryptionKey'>; store: Store },
  repo: string,
  event: AgentEvent,
  tokens: Record<string, string> = {},
): Promise<RepositoryAccess | undefined> {
  for (const integration of Object.values(integrations)) {
    if (
      (!event.repo && integration.id === event.integration) ||
      !integration.repos ||
      !tokens[integration.id]
    )
      continue;
    return { contents: integration as Contents, token: tokens[integration.id]! };
  }
  const [owner, name] = repo.split('/');

  for (const { value: app } of await options.store.list('app')) {
    if (app.agentsRepo !== repo) continue;

    const integration = integrations[app.integration];
    if (!integration?.repos) continue;

    const installation = (await options.store.list('installation', { prefix: `${app.id}:` })).find(
      entry => !entry.value.deletedAt,
    )?.value;
    if (!installation) continue;

    try {
      const plain = installation.token
        ? { ...installation, token: decryptSecret<string>(options.config, installation.token) }
        : installation;
      return {
        contents: integration as Contents,
        token: await integration.auth.token(plain, decryptSecret(options.config, app.credentials), {
          ...(owner && name ? { repo: { owner, name } } : {}),
          tools: integration.tools.presets.observe,
        }),
        app,
        installation,
      };
    } catch {
      continue;
    }
  }

  return undefined;
}

/** Disk agents win; otherwise records are authoritative and only usage is cached per repo/ref. */
export function remoteAgentLoader(
  integrations: Record<string, Integration>,
  options: {
    cwd?: string;
    config: Pick<ServerConfig, 'encryptionKey'>;
    store: Store;
    now?: () => number;
  },
): ServerContext['loadAgent'] {
  const cwd = options.cwd ?? process.cwd();
  const now = options.now ?? Date.now;
  // Owned by this loader; an entry serves one minute, so repository edits land without a restart.
  const usageCache = new Map<string, { at: number; usage: Promise<unknown> }>();

  async function usageFor(
    installation: Installation,
    event: AgentEvent,
    tokens: Record<string, string>,
  ): Promise<unknown> {
    const reader = repositoryReader(integrations);
    const token = reader && tokens[reader.id];
    if (!reader?.repos || !token) return undefined;
    const repo = eventRepo(event);
    if (event.integration === reader.id && repo)
      return readUsage(reader as Contents, repo, token, event.repo?.ref);
    const configRepo = installation.settings?.configRepo;
    if (configRepo) return readUsage(reader as Contents, configRepo, token);
    return undefined;
  }

  function cachedUsage(
    app: AgentApp,
    installation: Installation,
    event: AgentEvent,
    tokens: Record<string, string>,
  ): Promise<unknown> {
    const key = `${app.id}@${eventRepo(event) ?? installation.settings?.configRepo ?? ''}@${event.repo?.ref ?? ''}`;
    const at = now();
    for (const [entry, value] of usageCache)
      if (at - value.at >= USAGE_TTL_MS) usageCache.delete(entry);
    let cached = usageCache.get(key);
    if (!cached) {
      cached = { at, usage: usageFor(installation, event, tokens) };
      usageCache.set(key, cached);
    }
    return cached.usage;
  }

  async function stored(
    app: AgentApp,
    installation: Installation,
    event: AgentEvent,
    tokens: Record<string, string>,
  ): Promise<Agent | undefined> {
    let loaded = await agentWithVersion(options.store, app.agent);
    if (loaded.record && (await seedBuiltinAgent(options.store, now(), app.agent, loaded)))
      loaded = await agentWithVersion(options.store, app.agent);
    const { record, version } = loaded;
    if (!record) return undefined;
    if (!version) throw new Error(`No version ${record.currentVersion} for agent "${record.id}".`);
    const usage = await cachedUsage(app, installation, event, tokens);
    const entry =
      usage && typeof usage === 'object'
        ? (usage as Record<string, unknown>)[app.agent]
        : undefined;
    if (entry === false)
      throw new Error(
        `Agent "${app.agent}" is disabled in ${eventRepo(event) ?? installation.settings?.configRepo ?? app.agentsRepo}.`,
      );
    return toAgent(
      record,
      version,
      entry && typeof entry === 'object' ? (entry as AgentUsage) : undefined,
      integrations,
    );
  }

  return async (app, installation, event, tokens) => {
    const onDisk = (await loadAgents(cwd, integrations)).find(
      candidate => candidate.id === app.agent && !candidate.builtin,
    );
    if (onDisk) return onDisk;

    const existing = await stored(app, installation, event, tokens);
    if (existing) return existing;

    if (app.agentsRepo) {
      const access = await repositoryAccess(integrations, options, app.agentsRepo, event, tokens);
      if (access) {
        await importRepoAgents(
          options.store,
          access.contents,
          app.agentsRepo,
          eventRepo(event) === app.agentsRepo ? (event.repo?.ref ?? 'HEAD') : 'HEAD',
          access.token,
          now(),
        );
        const imported = await stored(app, installation, event, tokens);
        if (imported) return imported;
        throw new Error(`No agent "${app.agent}" in ${app.agentsRepo}.`);
      }
    }

    if (await seedBuiltinAgent(options.store, now(), app.agent, {})) {
      const builtin = await stored(app, installation, event, tokens);
      if (builtin) return builtin;
    }
    throw new Error(
      app.agentsRepo ? `No agent named "${app.agent}".` : `No built-in agent "${app.agent}".`,
    );
  };
}

async function remoteFiles(
  contents: Contents,
  repo: string,
  root: string,
  token: string,
  ref: string,
  relative = '',
  entries?: string[],
  depth = 0,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const current =
    entries ??
    (await contents.repos.listDir(repo, relative ? `${root}/${relative}` : root, token, ref));
  for (const entry of current) {
    const name = relative ? `${relative}/${entry}` : entry;
    if (name === 'agent.json' || name === 'system.md') continue;
    const value = await contents.repos.readFile(repo, `${root}/${name}`, token, ref);
    if (value !== undefined) result[name] = value;
    else if (depth < 20) {
      const children = await contents.repos.listDir(repo, `${root}/${name}`, token, ref);
      if (children.length && !isDeepStrictEqual(children, current))
        Object.assign(
          result,
          await remoteFiles(contents, repo, root, token, ref, name, children, depth + 1),
        );
    }
  }
  return result;
}

export async function importRepoAgents(
  store: Store,
  contents: Contents,
  repo: string,
  ref: string,
  token: string,
  now: number,
  opts: { path?: string; slugs?: string[]; branch?: string } = {},
): Promise<AgentVersionRecord[]> {
  const base = opts.path ?? AGENTS_DIR;
  const commit = /^[0-9a-f]{40}$/i.test(ref)
    ? ref
    : ((await contents.repos.commit(repo, ref, token)) ?? ref);
  const source = { repo, ref: opts.branch ?? ref, commit };
  ref = commit;
  const slugs = opts.slugs ?? (await contents.repos.listDir(repo, base, token, ref));
  assertNotReserved(slugs);
  const imported: AgentVersionRecord[] = [];
  for (const id of slugs) {
    const root = `${base}/${id}`;
    const raw = await contents.repos.readFile(repo, `${root}/agent.json`, token, ref);
    if (raw === undefined) continue;
    const definition = JSON.parse(raw) as unknown;
    const [validated] = agentsFromSources(
      {
        definitions: { [id]: { json: definition, builtin: false } },
        usage: undefined,
      },
      { ...INTEGRATIONS, [contents.id]: contents },
    );
    if (!validated) continue;
    imported.push(
      await publishVersion(
        store,
        {
          id,
          name: validated.name,
          description: validated.definition.description,
          source: 'repo',
          repo,
          path: root,
          definition: validated.definition,
          systemPrompt:
            (await contents.repos.readFile(repo, `${root}/system.md`, token, ref)) ?? '',
          files: await remoteFiles(contents, repo, root, token, ref),
          commit,
          origin: source,
          importedFrom: `repo:${repo}@${source.ref}`,
        },
        now,
      ),
    );
  }
  return imported;
}

/** Sync each app under its store lock, retaining failed versions for a publish retry. */
export async function updateApps(
  ctx: ServerContext,
  versions: AgentVersionRecord[],
): Promise<void> {
  const publicUrl = ctx.config.publicUrl;
  if (!publicUrl || !versions.length) return;

  const agents = new Map(versions.map(version => [version.agent, version]));
  const apps = await ctx.store.list('app');
  const results = await Promise.all(
    apps
      .filter(({ value }) => agents.has(value.agent))
      .map(async ({ id }) => {
        return ctx.store.withAppLock(id, async store => {
          const app = await store.get('app', id);
          if (!app || !agents.has(app.agent)) return;

          const version = (await getVersion(store, app.agent)) ?? agents.get(app.agent)!;
          const update = ctx.integrations[app.integration]?.app.update;
          if (!update || !version.definition.integrations[app.integration]) return;

          const key = `app-sync:${id}`;
          const synced = await store.get<{
            version: number;
            definition: unknown;
            pending: boolean;
          }>('delivery', key);
          if (
            synced &&
            !synced.pending &&
            synced.version >= version.version &&
            isDeepStrictEqual(synced.definition, version.definition)
          )
            return;
          if (synced && synced.version > version.version) return;

          const marker = {
            version: version.version,
            definition: version.definition,
            pending: true,
          };

          await store.put('delivery', key, marker);
          try {
            const credentials = await update(app, decryptSecret(ctx.config, app.credentials), {
              publicUrl,
              definition: version.definition,
              fetch: ctx.fetch ?? fetch,
              saveCredentials: async credentials => {
                await store.put('app', app.id, {
                  ...app,
                  credentials: encryptSecret(ctx.config, credentials),
                });
              },
            });
            if (credentials)
              await store.put('app', app.id, {
                ...app,
                credentials: encryptSecret(ctx.config, credentials),
              });
            await store.put('delivery', key, { ...marker, pending: false });
          } catch (error) {
            const message = `Could not sync ${app.integration} app ${app.id}. ${error instanceof Error ? error.message : String(error)}`;
            await store.put('delivery', key, { ...marker, error: message });
            return message;
          }
        });
      }),
  );
  const errors = results.filter(Boolean);
  if (errors.length) throw new Error(errors.join('\n'));
}

export function sourceEvent(): AgentEvent {
  return {
    integration: 'source',
    type: 'import',
    appId: '',
    installationId: '',
    deliveryId: '',
    actor: { id: 'admin' },
    text: '',
  };
}

/** Import `repo`'s agents at `ref` and update their apps; undefined when no installed app can read it. */
export async function importAgents(
  ctx: ServerContext,
  repo: string,
  ref: string,
  event = sourceEvent(),
  branch?: string,
): Promise<AgentVersionRecord[] | undefined> {
  const access = await repositoryAccess(
    ctx.integrations,
    { config: ctx.config, store: ctx.store },
    repo,
    event,
  );
  if (!access) return undefined;

  const versions = await importRepoAgents(
    ctx.store,
    access.contents,
    repo,
    ref,
    access.token,
    (ctx.now ?? Date.now)(),
    branch ? { branch } : {},
  );
  await updateApps(ctx, versions);
  return versions;
}
