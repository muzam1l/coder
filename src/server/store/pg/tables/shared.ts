/** What every table adapter shares: the `Kind` shape, column conversions, and id and secret lookups. */
import { and, eq, getTableColumns, type SQL } from 'drizzle-orm';
import { CasingCache } from 'drizzle-orm/casing';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

import { CASING } from '../client';

import type { AgentRecord, AgentVersionRecord, TaskStatus } from '../../types';
import {
  agent,
  agentVersion,
  integrationApp,
  integrationAppInstallation,
  secret,
  task,
} from '../schema';
import { secretKeyVersion } from '../../secrets';
import type { DrizzleStore } from '../store';

export function storedTaskContext(value: TaskStatus['task']) {
  return value.connections === undefined && !value.engineChain && !value.engineCredentials
    ? value.context
    : {
        ...value.context,
        connections: value.connections,
        engineChain: value.engineChain,
        engineCredentials: value.engineCredentials,
      };
}

export function readTaskContext(value: TaskStatus['task']['context'] | null) {
  const { connections, runnerLogs, engineChain, engineCredentials, ...context } = (value ??
    {}) as NonNullable<TaskStatus['task']['context']> & {
    connections?: string[];
    engineChain?: string[];
    engineCredentials?: Record<string, string>;
    runnerLogs?: {
      at?: number;
      complete?: boolean;
      handle?: string;
      attempts?: number;
      generation?: number;
    };
  };

  return {
    connections,
    runnerLogs,
    engineChain,
    engineCredentials,
    context: Object.keys(context).length ? context : undefined,
  };
}

/** Postgres requests acquire their organization from a session, app, or task. */
export const UNSCOPED_ORGANIZATION = '';

export type Rows<T> = Array<{ id: string; value: T }>;

export interface Kind<T> {
  key: PgColumn | SQL;
  where?(options: { id?: string; prefix?: string; after?: string }): SQL;
  /** Column predicates for a `<parent>:<padded number>` key, so lookups use the indexes. */
  split?(parent: string, from?: number, exact?: boolean): SQL;
  rows(where: SQL | undefined, limit?: number): Promise<Rows<T>>;
  put(id: string, value: T, expiresAt: Date | null, opts?: { unarchive?: boolean }): Promise<void>;
  delete(id: string): Promise<void>;
}

export function splitKey(id: string): [string, number] | undefined {
  const at = id.lastIndexOf(':');
  const tail = id.slice(at + 1);
  return at > 0 && /^\d+$/.test(tail) ? [id.slice(0, at), Number(tail)] : undefined;
}

export const app = integrationApp;
export const install = integrationAppInstallation;
export const ms = (value: Date) => value.getTime();
export const date = (value: number) => new Date(value);
export const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');
type Clean<T> = { [K in keyof T]: Exclude<T[K], null> };
// Nullable columns become absent keys, so records read back equal the ones written.
export const defined = <T extends object>(value: T): Clean<T> =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined && v !== null),
  ) as Clean<T>;
const optionalMs = (value: Date | null) => (value ? ms(value) : undefined);
// A repository import records `repo:<owner/name>@<ref>` and the commit it read.
const repoSource = (importedFrom: string, commit: string | null) => {
  const found = /^repo:([^@]+)@(.+)$/.exec(importedFrom);
  return found && commit ? { repo: found[1]!, ref: found[2]!, commit } : undefined;
};
export const agentValue = (r: typeof agent.$inferSelect): AgentRecord =>
  defined({
    id: r.slug,
    name: r.name,
    description: r.description,
    problems: r.problems,
    source: r.source,
    repo: r.repo,
    path: r.path,
    currentVersion: r.currentVersion,
    settings: r.settings,
    createdAt: ms(r.createdAt),
    updatedAt: ms(r.updatedAt),
  }) as AgentRecord;
export const versionValue = (
  r: typeof agentVersion.$inferSelect,
  slug: string,
): AgentVersionRecord =>
  defined({
    agent: slug,
    version: r.version,
    definition: r.definition,
    systemPrompt: r.systemPrompt,
    files: r.files,
    commit: r.commit,
    source: repoSource(r.importedFrom, r.commit),
    importedFrom: r.importedFrom,
    createdAt: ms(r.createdAt),
  }) as AgentVersionRecord;

export const versionColumns = {
  id: agentVersion.id,
  agentId: agentVersion.agentId,
  version: agentVersion.version,
  definition: agentVersion.definition,
  commit: agentVersion.commit,
  importedFrom: agentVersion.importedFrom,
  createdAt: agentVersion.createdAt,
};
export const versionSummary = (
  r: Omit<typeof agentVersion.$inferSelect, 'systemPrompt' | 'files'>,
  slug: string,
) => {
  const { systemPrompt, files, ...summary } = versionValue(
    { ...r, systemPrompt: '', files: null },
    slug,
  );
  return summary;
};

/** A row `to_jsonb` rendered, back in the shape drizzle's own select returns. */
export function fromJson<T extends PgTable>(
  table: T,
  record: Record<string, unknown>,
): T['$inferSelect'] {
  const casing = new CasingCache(CASING);

  return Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => {
      const value = record[casing.getColumnCasing(column)];
      return [key, value === null || value === undefined ? null : column.mapFromDriverValue(value)];
    }),
  ) as T['$inferSelect'];
}

/** A `task` row as the `TaskStatus` record the rest of the server reads. */
export function taskRecord(r: typeof task.$inferSelect): TaskStatus {
  const context = readTaskContext(r.context);

  return defined({
    task: defined({
      id: r.publicId,
      source: r.source,
      agent: r.agent,
      flow: r.flow,
      runner: r.runner as TaskStatus['task']['runner'],
      permissions: r.permissions,
      event: r.event,
      prompt: r.prompt,
      args: r.args,
      mcp: r.mcp,
      connections: context.connections,
      author: r.author,
      definition: r.definition,
      credential: r.credential,
      engineChain: context.engineChain,
      engineCredentials: context.engineCredentials,
      requester: r.requester,
      runnerId: r.runnerId,
      usage: r.usage,
      tools: r.tools,
      toolScopes: r.toolScopes,
      context: context.context,
      files: r.files,
    }),
    status: r.status,
    attempts: r.attempts,
    generation: r.generation,
    inboxSeq: r.inboxSeq,
    inboxAck: r.inboxAck < 0 ? undefined : { generation: r.generation, seq: r.inboxAck },
    result: r.result,
    error: r.error,
    tokens: r.tokens,
    handle: r.handle,
    tokenHash: r.tokenHash,
    lastSeenAt: optionalMs(r.lastSeenAt),
    logCursor: r.logCursor ?? undefined,
    logSeq: r.logSeq ?? undefined,
    logBytes: r.logBytes ?? undefined,
    ...((context.runnerLogs?.handle ?? null) === r.handle &&
    context.runnerLogs?.attempts === r.attempts &&
    context.runnerLogs?.generation === r.generation
      ? { logsComplete: context.runnerLogs?.complete }
      : {}),
    archivedAt: optionalMs(r.archivedAt),
    approval: r.approval,
    answer: Array.isArray(r.answer) ? r.answer : undefined,
    createdAt: ms(r.createdAt),
    startedAt: optionalMs(r.startedAt),
    finishedAt: optionalMs(r.finishedAt),
    cancelRequestedAt: optionalMs(r.cancelRequestedAt),
    updatedAt: ms(r.updatedAt),
  });
}



function secretParts(s: DrizzleStore, value: string) {
  if (value.startsWith('plain.'))
    return {
      iv: 'plain',
      tag: '',
      ciphertext: value.slice(6),
      keyVersion: 0,
    };
  const [iv, tag, ciphertext] = value.split('.');
  if (!iv || !tag || !ciphertext) throw new Error('Invalid encrypted secret');
  return {
    iv,
    tag,
    ciphertext,
    keyVersion: secretKeyVersion(s.encryption, value),
  };
}

export function opaque(value: { iv: string; tag: string; ciphertext: string }): string {
  return value.iv === 'plain'
    ? `plain.${value.ciphertext}`
    : `${value.iv}.${value.tag}.${value.ciphertext}`;
}

export async function addSecret(
  s: DrizzleStore,
  kind: 'app' | 'installation' | 'engine' | 'runner',
  value: string,
): Promise<number> {
  const [created] = await s.db
    .insert(secret)
    .values({
      organizationId: s.organizationId,
      kind,
      ...secretParts(s, value),
    })
    .returning({ id: secret.id });
  return created!.id;
}

export async function setSecret(s: DrizzleStore, id: number, value: string): Promise<void> {
  await s.db
    .update(secret)
    .set({ ...secretParts(s, value), updatedAt: s.at() })
    .where(and(s.mine(secret.organizationId), eq(secret.id, id)));
}

export const statePrefix = (organizationId: string, kind: string) =>
  `o:${JSON.stringify([organizationId, kind])}:`;
export const stateKey = (organizationId: string, kind: string, id: string) =>
  statePrefix(organizationId, kind) + id;

export async function rows<T>(db: import('../client').Db, statement: SQL): Promise<T[]> {
  const result = (await db.execute(statement)) as unknown as T[] | { rows: T[] };
  return Array.isArray(result) ? result : result.rows;
}
