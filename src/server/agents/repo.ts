import { appTokens } from './tokens';
/** Agents that live in a repository: reading it through an installed app, importing its versions, and loading one app's agent. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { AgentLoadError, agentsFromSources, assertNotReserved, loadAgents } from '../../agent/load';
import { INTEGRATIONS } from '../../integrations';
import type { AppDrift, Integration, IntegrationApp, Pushed } from '../../integrations/types';
import type { AppCheck } from '../../client/types';
import type {
  Agent,
  AgentApp,
  AgentDefinition,
  AgentEvent,
  AgentUsage,
  Installation,
} from '../../agent/types';
import type { AgentVersionRecord, Store } from '../store/types';
import type { ServerConfig, ServerContext } from '../context';
import type { PlatformAccess, TokenSource } from '../tasks/context';
import { decryptSecret, encryptSecret } from '../store/secrets';
import {
  agentWithVersion,
  getVersion,
  publishVersion,
  seedBuiltinAgent,
  ensureBuiltinAgents,
  toAgent,
} from './records';

export type Contents = Integration & Required<Pick<Integration, 'repos'>>;

export const AGENTS_DIR = '.coder/agents';
const CONFIG_FILE = '.coder/config.json';
/** Collects copies no read, revalidation or push renewed for this long. */
const FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Outlives any read in flight when a push lands. */
const PUSH_FENCE_TTL_MS = 60 * 60 * 1000;
/** A branch's copy is revalidated this often even without a push, in case its webhook was lost. */
const BRANCH_FILE_FRESH_MS = 10 * 60 * 1000;
const FILE_READ_TIMEOUT_MS = 10_000;

function eventRepo(event: AgentEvent): string | undefined {
  return event.repo ? `${event.repo.owner}/${event.repo.name}` : undefined;
}

export interface RepoFile {
  text?: string;
  etag?: string;
  readAt?: number;
  /** Pushed since it was read; the next read revalidates it. */
  stale?: true;
}

/** A branch's latest push, so a read that began before it never lands as fresh. */
export interface RepoPush {
  push: string;
}

const fileKey = (installation: string, repo: string, ref: string) =>
  `repo-file:${installation}@${repo}@${ref}:`;

/** The repository file snapshots an event's dispatch may read: the event's repository at its default branch, through its installation. */
export function dispatchFilePrefixes(installation: Installation, event: AgentEvent): string[] {
  const repo = eventRepo(event);

  return repo ? [fileKey(installation.id, repo, event.repo?.defaultBranch ?? '')] : [];
}
const pushKey = (installation: string, repo: string, ref: string) =>
  `repo-push:${installation}@${repo}@${ref}`;

/** A repository file as Coder last read it through `access`, revalidated by ETag once a push marked it stale or, on a branch, after 10 minutes; the token is minted only then. Concurrent reads of one file share one. */
export function cachedFile(
  ctx: Pick<ServerContext, 'store' | 'fileReads'>,
  contents: Integration,
  access: PlatformAccess,
  repo: string,
  path: string,
  ref?: string,
): Promise<string | undefined> {
  const key = `${fileKey(access.installation, repo, ref ?? '')}${path}`;
  const reads = (ctx.fileReads ??= new Map());
  let read = reads.get(key);
  if (!read) {
    const signal = AbortSignal.timeout(FILE_READ_TIMEOUT_MS);
    const deadline = new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
    read = Promise.race([
      storedFile(ctx.store, contents, access, repo, path, ref, key, signal),
      deadline,
    ])
      .catch(error => {
        if (signal.aborted)
          console.error(`coder server: repository file read timed out for ${repo}/${path}`, error);
        throw error;
      })
      .finally(() => reads.delete(key));
    reads.set(key, read);
  }

  return read;
}

async function storedFile(
  store: Store,
  contents: Integration,
  access: PlatformAccess,
  repo: string,
  path: string,
  ref: string | undefined,
  key: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const held = await store.get<RepoFile>('snapshot', key);
  signal.throwIfAborted();
  const commit = /^[0-9a-f]{40}$/i.test(ref ?? '');
  const now = Date.now();
  if (held && !held.stale && (commit || now - (held.readAt ?? 0) < BRANCH_FILE_FRESH_MS))
    return held.text;

  const fence = pushKey(access.installation, repo, ref ?? '');
  const [token, push] = await Promise.all([
    access.token(),
    commit ? undefined : store.get<RepoPush>('snapshot', fence),
  ]);
  signal.throwIfAborted();
  if (!token || !contents.repos) return undefined;

  const read = contents.repos.revalidate
    ? await contents.repos.revalidate(repo, path, token, {
        ...(ref ? { ref } : {}),
        ...(held?.etag ? { etag: held.etag } : {}),
        fetch: ((input, init) => access.fetch(input, { ...init, signal })) as typeof fetch,
      })
    : { text: await contents.repos.readFile(repo, path, token, ref) };
  signal.throwIfAborted();
  const { stale: _stale, ...kept } = held ?? {};
  const file = { ...(read === 'unchanged' ? kept : read), ...(commit ? {} : { readAt: now }) };
  await store.put('snapshot', key, file, { ttlMs: FILE_TTL_MS });
  if (!commit && (await store.get<RepoPush>('snapshot', fence))?.push !== push?.push)
    await store.put('snapshot', key, { ...file, stale: true }, { ttlMs: FILE_TTL_MS });

  return file.text;
}

/** Marks the files Coder holds for a pushed branch stale; the default branch's are also held under no ref. */
export async function pushedFiles(store: Store, pushed: Pushed): Promise<void> {
  const refs = [pushed.branch, ...(pushed.branch === pushed.defaultBranch ? [''] : [])];
  for (const ref of refs) {
    await store.put(
      'snapshot',
      pushKey(pushed.installation, pushed.repo, ref),
      { push: randomUUID() },
      { ttlMs: PUSH_FENCE_TTL_MS },
    );
    for (const { id, value } of await store.list<RepoFile>('snapshot', {
      prefix: fileKey(pushed.installation, pushed.repo, ref),
    }))
      if (!value.stale)
        await store.put('snapshot', id, { ...value, stale: true }, { ttlMs: FILE_TTL_MS });
  }
}

async function readUsage(
  ctx: Pick<ServerContext, 'store' | 'fileReads'>,
  contents: Integration,
  access: PlatformAccess,
  repo: string,
  ref?: string,
): Promise<unknown> {
  const config = await cachedFile(ctx, contents, access, repo, CONFIG_FILE, ref);
  return config === undefined ? undefined : (JSON.parse(config) as { agents?: unknown }).agents;
}

export interface RepositoryAccess {
  contents: Contents;
  token: string;
  app?: AgentApp;
  installation?: Installation;
}

/** Find repository contents access from the event's tokens or an installed app that owns the repo. */
async function repositoryAccess(
  integrations: Record<string, Integration>,
  options: { config: Pick<ServerConfig, 'encryptionKey'>; store: Store },
  repo: string,
  event: AgentEvent,
  tokens: TokenSource = async () => undefined,
): Promise<RepositoryAccess | undefined> {
  for (const integration of Object.values(integrations)) {
    if ((!event.repo && integration.id === event.integration) || !integration.repos) continue;
    const token = await (await tokens(integration.id))?.token();
    if (token) return { contents: integration as Contents, token };
  }

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
          tools: integration.tools.presets.read,
        }),
        app,
        installation,
      };
    } catch (error) {
      console.error(`coder server: repository access for ${installation.id} failed`, error);
      continue;
    }
  }

  return undefined;
}

/** Disk agents win; otherwise records are authoritative and usage is read through the repository file cache. */
export function remoteAgentLoader(
  integrations: Record<string, Integration>,
  options: {
    cwd?: string;
    config: Pick<ServerConfig, 'encryptionKey'>;
    store: Store;
    fileReads?: ServerContext['fileReads'];
    now?: () => number;
    settings?: ServerContext['settings'];
  },
): ServerContext['loadAgent'] {
  type LoadedAgent = NonNullable<Parameters<ServerContext['loadAgent']>[4]>;
  const cwd = options.cwd;
  const now = options.now ?? Date.now;

  /** The usage in the event's own repository, when it has one. */
  async function usageFor(
    files: Pick<ServerContext, 'store' | 'fileReads'>,
    event: AgentEvent,
    tokens: TokenSource,
  ): Promise<unknown> {
    const repo = eventRepo(event);
    const contents = integrations[event.integration];
    const access = repo && contents?.repos && (await tokens(event.integration));
    if (!repo || !access) return undefined;

    return readUsage(files, contents!, access, repo, event.repo?.defaultBranch);
  }

  async function stored(
    app: AgentApp,
    event: AgentEvent,
    tokens: TokenSource,
    known?: LoadedAgent,
  ): Promise<Agent | undefined> {
    const files = { store: known?.store ?? options.store, fileReads: options.fileReads };
    let loaded = known ?? (await agentWithVersion(options.store, app.agent));
    if (loaded.record?.source === 'builtin' && !options.settings?.builtinAgents) {
      await ensureBuiltinAgents(options, now());
      loaded = await agentWithVersion(options.store, app.agent);
    }
    const { record, version } = loaded;
    if (!record) return undefined;
    if (record.problems?.length) throw new AgentLoadError(record.problems.join('\n'));
    if (!version) throw new Error(`No version ${record.currentVersion} for agent "${record.id}".`);
    const usage = await usageFor(files, event, tokens);
    const entry =
      usage && typeof usage === 'object'
        ? (usage as Record<string, unknown>)[app.agent]
        : undefined;
    if (entry === false || (entry as AgentUsage | undefined)?.disabled)
      throw new Error(
        `Agent "${app.agent}" is disabled in ${eventRepo(event) ?? app.agentsRepo}.`,
      );
    return toAgent(
      record,
      version,
      entry && typeof entry === 'object' ? (entry as AgentUsage) : undefined,
      integrations,
    );
  }

  return async (app, _installation, event, tokens, known) => {
    const onDisk = cwd
      ? (await loadAgents(cwd, integrations)).find(
          candidate => candidate.id === app.agent && !candidate.builtin,
        )
      : undefined;
    if (onDisk) return onDisk;

    const existing = await stored(app, event, tokens, known);
    if (existing) return existing;

    if (app.agentsRepo) {
      const access = await repositoryAccess(integrations, options, app.agentsRepo, event, tokens);
      if (access) {
        await importRepoAgents(
          options.store,
          access.contents,
          app.agentsRepo,
          eventRepo(event) === app.agentsRepo ? (event.repo?.defaultBranch ?? 'HEAD') : 'HEAD',
          access.token,
          now(),
        );
        const imported = await stored(app, event, tokens);
        if (imported) return imported;
        throw new Error(`No agent "${app.agent}" in ${app.agentsRepo}.`);
      }
    }

    if (await seedBuiltinAgent(options.store, now(), app.agent, {})) {
      const builtin = await stored(app, event, tokens);
      if (builtin) return builtin;
    }
    throw new Error(
      app.agentsRepo ? `No agent named "${app.agent}".` : `No built-in agent "${app.agent}".`,
    );
  };
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
  const tree = await contents.repos.tree(repo, base, token, ref);
  const slugs = opts.slugs ?? [
    ...new Set(
      tree.filter(file => /^[^/]+\/agent\.json$/.test(file)).map(file => file.split('/')[0]!),
    ),
  ];
  assertNotReserved(slugs);
  const imported = await Promise.all(
    slugs.map(async id => {
      const root = `${base}/${id}`;
      const paths = tree.filter(file => file.startsWith(`${id}/`) && file.split('/').length <= 22);
      const files = Object.fromEntries(
        await Promise.all(
          paths.map(
            async file =>
              [
                file.slice(id.length + 1),
                await contents.repos.readFile(repo, `${base}/${file}`, token, ref),
              ] as const,
          ),
        ),
      );
      const raw = files['agent.json'];
      if (raw === undefined) return;
      let validated: Agent | undefined;
      try {
        [validated] = agentsFromSources(
          { definitions: { [id]: { json: JSON.parse(raw), builtin: false } }, usage: undefined },
          { ...INTEGRATIONS, [contents.id]: contents },
        );
      } catch (error) {
        if (!(error instanceof AgentLoadError || error instanceof SyntaxError)) throw error;
        console.error(`coder server: could not load agent ${id}`, error);
        const existing = await store.get('agent', id);
        await store.put('agent', id, {
          id,
          name: id,
          source: 'repo',
          repo,
          path: root,
          currentVersion: 0,
          createdAt: now,
          ...existing,
          problems: [error.message],
          updatedAt: now,
        });
        return;
      }
      if (!validated) return;
      const { 'agent.json': _definition, 'system.md': systemPrompt, ...extra } = files;

      return publishVersion(
        store,
        {
          id,
          name: validated.name,
          description: validated.definition.description,
          source: 'repo',
          repo,
          path: root,
          definition: validated.definition,
          systemPrompt: systemPrompt ?? '',
          files: Object.fromEntries(
            Object.entries(extra).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          commit,
          origin: source,
          importedFrom: `repo:${repo}@${source.ref}`,
        },
        now,
      );
    }),
  );

  return imported.filter((version): version is AgentVersionRecord => !!version);
}

/** What Coder last knew an app to have on its platform, stored as delivery `app-sync:<app id>`. */
export interface SyncMarker {
  version: number;
  /** What the last push sent, or the values a person last confirmed by hand. */
  manifest?: unknown;
  pending?: boolean;
  error?: string;
  /** The last check found the app needing changes on its platform. */
  changed?: boolean;
}

export const syncKey = (app: string) => `app-sync:${app}`;

/** What a push sends for a definition, so a new manifest reaches the app without a definition change. */
export const syncManifest = (
  platform: IntegrationApp,
  app: AgentApp,
  publicUrl: string,
  definition: AgentDefinition,
) => platform.manifest?.(app, { publicUrl, definition }) ?? definition;

/** Whether the app already has `manifest` as of `version`. */
export const inSync = (marker: SyncMarker | undefined, version: number, manifest: unknown) =>
  Boolean(
    marker &&
    !marker.pending &&
    marker.version >= version &&
    isDeepStrictEqual(marker.manifest, manifest),
  );

/** Checks an app Coder cannot push and stores what it found on the app's sync marker; reads the platform only where it can be read. */
export async function checkApp(
  ctx: ServerContext,
  store: Store,
  app: AgentApp,
  version: AgentVersionRecord,
): Promise<AppCheck | undefined> {
  const platform = ctx.integrations[app.integration]?.app;
  const publicUrl = ctx.config.publicUrl!;
  const marker = await store.get<SyncMarker>('delivery', syncKey(app.id));

  if (platform?.values) {
    const drift = platform.values(app, { publicUrl, definition: version.definition });
    const known = (marker?.manifest ?? []) as AppDrift['lines'];
    const lines = drift.lines.map(line =>
      known.some(seen => seen.text === line.text && seen.copy === line.copy)
        ? line
        : { ...line, changed: true as const },
    );
    const changed = lines.some(line => 'changed' in line);
    if (changed !== marker?.changed)
      await store.put('delivery', syncKey(app.id), {
        ...marker,
        version: version.version,
        changed,
      });

    return { ...drift, lines, changed, confirm: true };
  }
  if (!platform?.drift) return undefined;

  const drift = await platform.drift(app, decryptSecret(ctx.config, app.credentials), {
    publicUrl,
    definition: version.definition,
    fetch: ctx.fetch ?? fetch,
  });
  const changed = drift.lines.length > 0;
  await store.put('delivery', syncKey(app.id), { version: version.version, changed });

  return { ...drift, changed };
}

/** An app a sync pushed or checked, or the error it failed with. */
export type AppSynced = { app: AgentApp; error?: string; check?: AppCheck };

/** Sync each app under its store lock, retaining failed versions for a publish retry; `force` pushes that one app even when it looks synced. */
export async function syncApps(
  ctx: ServerContext,
  versions: AgentVersionRecord[],
  force?: string,
): Promise<AppSynced[]> {
  const publicUrl = ctx.config.publicUrl;
  if (!publicUrl || !versions.length) return [];

  const agents = new Map(versions.map(version => [version.agent, version]));
  const apps = await ctx.store.list('app');
  const results = await Promise.all(
    apps
      .filter(({ id, value }) => agents.has(value.agent) && (!force || id === force))
      .map(async ({ id }) => {
        return ctx.store.withAppLock(id, async store => {
          const app = await store.get('app', id);
          if (!app || !agents.has(app.agent)) return;

          const version = (await getVersion(store, app.agent)) ?? agents.get(app.agent)!;
          const platform = ctx.integrations[app.integration]?.app;
          if (!platform || !version.definition.integrations[app.integration]) return;
          // The server's shared apps are its operator's to change.
          if (!platform.update && (app.builtin || app.shared)) return;
          if (!platform.update)
            return checkApp(ctx, store, app, version).then(
              check => check && { app, check },
              (error: unknown) => {
                console.error(`coder server: checking ${app.id} on its platform failed`, error);
                return { app, error: error instanceof Error ? error.message : String(error) };
              },
            );
          const { update } = platform;

          const manifest = syncManifest(platform, app, publicUrl, version.definition);
          const key = syncKey(id);
          const synced = await store.get<SyncMarker>('delivery', key);
          if (!force && inSync(synced, version.version, manifest)) return;
          if (synced && synced.version > version.version) return;

          const marker = {
            version: version.version,
            manifest,
            pending: true,
          };

          await store.put('delivery', key, marker);
          try {
            const credentials = await update(app, decryptSecret(ctx.config, app.credentials), {
              publicUrl,
              definition: version.definition,
              fetch: ctx.fetch ?? fetch,
              tokens: appTokens({ ...ctx, store }, app.integration),
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
            return { app };
          } catch (error) {
            const message = `Could not sync ${app.integration} app ${app.id}. ${error instanceof Error ? error.message : String(error)}`;
            await store.put('delivery', key, { ...marker, error: message });
            return { app, error: message };
          }
        });
      }),
  );

  return results.filter(result => result !== undefined);
}

/** `syncApps`, failing with every push's error; a check that failed is only logged. */
export async function updateApps(
  ctx: ServerContext,
  versions: AgentVersionRecord[],
): Promise<void> {
  const synced = await syncApps(ctx, versions);
  const errors = synced.flatMap(({ app, error }) =>
    error && ctx.integrations[app.integration]?.app.update ? [error] : [],
  );
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
