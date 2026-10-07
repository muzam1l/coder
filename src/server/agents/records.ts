/** Server-owned agent records and their versions, seeded from built-ins. */
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { builtinDefinitions, agentsFromSources } from '../../agent/load';
import { parseAgentDefinition } from '../../agent/definition';
import { INTEGRATIONS } from '../../integrations';
import type { Integration } from '../../integrations/types';
import {
  PRESETS,
  type Agent,
  type AgentDefinition,
  type AgentUsage,
  type Preset,
} from '../../agent/types';
import { type AgentRecord, type AgentVersionRecord, type AgentPublication } from '../store/types';
import { readVersion } from '../../core/runtime';
import type { Store } from '../store/types';

export interface PublishAgentInput {
  id: string;
  name?: string;
  description?: string;
  source: AgentRecord['source'];
  repo?: string;
  path?: string;
  definition: unknown;
  systemPrompt: string;
  files?: Record<string, string>;
  commit?: string;
  origin?: AgentVersionRecord['source'];
  importedFrom: string;
}

export const versionKey = (slug: string, version: number) =>
  `${slug}:${String(version).padStart(6, '0')}`;

export function getAgent(store: Store, slug: string): Promise<AgentRecord | undefined> {
  return store.get('agent', slug);
}

export async function listAgents(store: Store): Promise<AgentRecord[]> {
  return (await store.list('agent')).map(row => row.value);
}

export async function getVersion(
  store: Store,
  slug: string,
  version?: number,
): Promise<AgentVersionRecord | undefined> {
  const selected = version ?? (await getAgent(store, slug))?.currentVersion;
  return selected === undefined ? undefined : store.get('agentversion', versionKey(slug, selected));
}

/** One agent with its current version, in one read where the store can. */
export async function agentWithVersion(
  store: Store,
  slug: string,
): Promise<{ record?: AgentRecord; version?: AgentVersionRecord }> {
  if (store.listAgentsWithVersions) return (await store.listAgentsWithVersions(slug))[0] ?? {};
  const record = await getAgent(store, slug);
  return { record, version: record && (await getVersion(store, slug, record.currentVersion)) };
}

/** Every agent with its current version, in one round of reads where the store can. */
export async function agentsWithVersions(
  store: Store,
): Promise<Array<{ record: AgentRecord; version?: AgentVersionRecord }>> {
  if (store.listAgentsWithVersions) return store.listAgentsWithVersions();
  const records = await listAgents(store);
  return Promise.all(
    records.map(async record => ({
      record,
      version: await getVersion(store, record.id, record.currentVersion),
    })),
  );
}

export async function publishAgent(
  store: Store,
  input: PublishAgentInput,
  now: number,
): Promise<AgentPublication> {
  if (store.publishAgent) {
    const definition = parseAgentDefinition(input.id, input.definition);
    const files = input.files && Object.keys(input.files).length ? input.files : undefined;
    return store.publishAgent(
      {
        id: input.id,
        name: input.name ?? definition.name ?? input.id,
        ...((input.description ?? definition.description)
          ? { description: input.description ?? definition.description }
          : {}),
        source: input.source,
        ...(input.repo ? { repo: input.repo } : {}),
        ...(input.path ? { path: input.path } : {}),
        currentVersion: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        agent: input.id,
        version: 0,
        definition,
        systemPrompt: input.systemPrompt,
        ...(files ? { files } : {}),
        ...(input.commit ? { commit: input.commit } : {}),
        ...(input.origin ? { source: input.origin } : {}),
        importedFrom: input.importedFrom,
        createdAt: now,
      },
    );
  }
  const loaded = await agentWithVersion(store, input.id);
  const version = await publishVersion(store, input, now, loaded);
  return {
    record: (await getAgent(store, input.id))!,
    version,
    unchanged: loaded.record?.currentVersion === version.version,
  };
}

export async function publishVersion(
  store: Store,
  input: PublishAgentInput,
  now: number,
  loaded?: { record?: AgentRecord; version?: AgentVersionRecord },
): Promise<AgentVersionRecord> {
  if (!loaded && store.publishAgent) return (await publishAgent(store, input, now)).version;

  const definition = parseAgentDefinition(input.id, input.definition);
  const files = input.files && Object.keys(input.files).length ? input.files : undefined;
  const existing = loaded ? loaded.record : await getAgent(store, input.id);
  const current = loaded
    ? loaded.version
    : existing
      ? await getVersion(store, input.id, existing.currentVersion)
      : undefined;
  const recordFor = (version: number, updatedAt: number): AgentRecord => ({
    id: input.id,
    name: input.name ?? definition.name ?? input.id,
    ...((input.description ?? definition.description)
      ? { description: input.description ?? definition.description }
      : {}),
    source: input.source,
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.path ? { path: input.path } : {}),
    currentVersion: version,
    ...(existing?.settings ? { settings: existing.settings } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt,
  });
  const same = (version: AgentVersionRecord) =>
    isDeepStrictEqual(version.definition, definition) &&
    version.systemPrompt === input.systemPrompt &&
    isDeepStrictEqual(version.files, files);
  if (current && same(current)) {
    const metadata = recordFor(current.version, existing!.updatedAt);
    if (!isDeepStrictEqual(existing, metadata))
      await store.put('agent', input.id, recordFor(current.version, now));
    return current;
  }

  if (!existing) await store.put('agent', input.id, recordFor(0, now));

  // Concurrent publishers each claim the next free number; one publishing the same content reuses it.
  let next: AgentVersionRecord;

  for (let version = (existing?.currentVersion ?? 0) + 1; ; version++) {
    next = {
      agent: input.id,
      version,
      definition,
      systemPrompt: input.systemPrompt,
      ...(files ? { files } : {}),
      ...(input.commit ? { commit: input.commit } : {}),
      ...(input.origin ? { source: input.origin } : {}),
      importedFrom: input.importedFrom,
      createdAt: now,
    };
    if (await store.create('agentversion', versionKey(input.id, version), next)) break;

    const taken = await store.get('agentversion', versionKey(input.id, version));
    if (taken && same(taken)) {
      next = taken;
      break;
    }
  }
  const latest = await getAgent(store, input.id);
  if (!latest || latest.currentVersion < next.version)
    await store.put('agent', input.id, recordFor(next.version, now));

  return next;
}

export async function setAgentSettings(
  store: Store,
  slug: string,
  settings: AgentUsage,
  now = Date.now(),
): Promise<AgentRecord> {
  const record = await getAgent(store, slug);
  if (!record) throw new Error(`No agent named "${slug}".`);
  const updated = { ...record, settings, updatedAt: now } satisfies AgentRecord;
  await store.put('agent', slug, updated);
  return updated;
}

const PERMISSIONS = ['read-only', 'workspace-write', 'auto'] as const;

function expand(value: Preset | string[], integration?: Integration): string[] {
  if (Array.isArray(value)) return [...new Set(value)];
  const through = PRESETS.indexOf(value);
  return [
    ...new Set(PRESETS.slice(0, through + 1).flatMap(key => integration?.tools.presets[key] ?? [])),
  ];
}

function mergedUsage(
  definition: AgentDefinition,
  base: AgentUsage | undefined,
  override: AgentUsage | undefined,
  integrations: Record<string, Integration>,
): AgentUsage | undefined {
  if (!base && !override) return undefined;
  const first = base ?? {};
  const second = override ?? {};
  const ids = new Set([
    ...Object.keys(first.integrations ?? {}),
    ...Object.keys(second.integrations ?? {}),
  ]);
  const integrationUsage = Object.fromEntries(
    [...ids].map(id => {
      const left = first.integrations?.[id];
      const right = second.integrations?.[id];
      const allowedEvents =
        left?.allowedEvents && right?.allowedEvents
          ? left.allowedEvents.filter(value => right.allowedEvents!.includes(value))
          : (right?.allowedEvents ?? left?.allowedEvents);
      const allowedTools =
        left?.allowedTools && right?.allowedTools
          ? expand(left.allowedTools, integrations[id]).filter(value =>
              new Set(expand(right.allowedTools!, integrations[id])).has(value),
            )
          : (right?.allowedTools ?? left?.allowedTools);
      return [
        id,
        {
          ...(allowedEvents ? { allowedEvents } : {}),
          ...(allowedTools ? { allowedTools } : {}),
        },
      ];
    }),
  );
  const maximum = first.permissions ?? definition.permissions ?? 'read-only';
  const requested = second.permissions;
  const permissions =
    requested && PERMISSIONS.indexOf(requested) <= PERMISSIONS.indexOf(maximum)
      ? requested
      : maximum;
  return {
    ...first,
    ...second,
    permissions,
    ...(ids.size ? { integrations: integrationUsage } : {}),
  };
}

export function toAgent(
  record: AgentRecord,
  version: AgentVersionRecord,
  usage?: AgentUsage,
  integrations: Record<string, Integration> = INTEGRATIONS,
): Agent {
  const organization = mergedUsage(version.definition, undefined, record.settings, integrations);
  const effective = mergedUsage(version.definition, organization, usage, integrations);
  const [agent] = agentsFromSources(
    {
      definitions: {
        [record.id]: {
          json: version.definition,
          builtin: record.source === 'builtin',
        },
      },
      usage: effective ? { [record.id]: effective } : undefined,
    },
    integrations,
  );
  if (!agent) throw new Error(`Agent "${record.id}" is disabled.`);
  return {
    ...agent,
    files: { ...(version.files ?? {}), 'system.md': version.systemPrompt },
  };
}

export function diskFiles(root: string, relative = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of fs.readdirSync(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, diskFiles(root, name));
    else if (entry.isFile() && name !== 'agent.json' && name !== 'system.md')
      result[name] = fs.readFileSync(path.join(root, name), 'utf8');
  }
  return result;
}

/** Publish built-in `id` when it differs from the stored record and version the caller loaded; true when it wrote a version. */
export async function seedBuiltinAgent(
  store: Store,
  now: number,
  id: string,
  loaded: { record?: AgentRecord; version?: AgentVersionRecord },
): Promise<boolean> {
  const builtin = builtinDefinitions()[id];
  if (!builtin) return false;
  const version = await publishVersion(
    store,
    {
      id,
      source: 'builtin',
      definition: builtin.json,
      systemPrompt: fs.readFileSync(path.join(builtin.dir, 'system.md'), 'utf8'),
      files: diskFiles(builtin.dir),
      importedFrom: `builtin:${readVersion()}`,
    },
    now,
    loaded,
  );
  return version !== loaded.version;
}

/** Publish every built-in that differs from the stored `agents`; true when any changed. */
export async function seedBuiltinAgents(
  store: Store,
  now: number,
  agents?: Array<{ record: AgentRecord; version?: AgentVersionRecord }>,
): Promise<boolean> {
  const loaded =
    agents ??
    (await Promise.all(Object.keys(builtinDefinitions()).map(id => agentWithVersion(store, id))));
  let changed = false;
  for (const id of Object.keys(builtinDefinitions()))
    if (
      await seedBuiltinAgent(store, now, id, loaded.find(({ record }) => record?.id === id) ?? {})
    )
      changed = true;
  return changed;
}
