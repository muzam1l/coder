/** What every table adapter shares: the `Kind` shape, column conversions, secret rows and usage rows. */
import { eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm';
import { CasingCache } from 'drizzle-orm/casing';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';

import { CASING, type Db } from '../client';

import type { AgentRecord, AgentVersionRecord, TaskStatus, UsageRecord } from '../../types';
import {
  agent,
  agentVersion,
  integrationApp,
  integrationAppInstallation,
  secret,
  task,
} from '../schema';
import { usageTarget } from '../../../tasks/usage';

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
    settings: r.engineSettings,
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
  return defined({
    task: defined({
      id: r.publicId,
      source: r.source,
      agent: r.agent,
      flow: r.flow,
      runner: r.runnerKind as TaskStatus['task']['runner'],
      access: r.access,
      event: r.event,
      name: r.name,
      cwd: r.cwd,
      prompt: r.prompt,
      args: r.args,
      mcp: r.mcp,
      appendSystem: r.appendSystem,
      addDirs: r.addDirs,
      connections: r.connections,
      author: r.author,
      definition: r.definition,
      models: r.models,
      requestedBy: r.requestedBy,
      audience: r.audience,
      space: r.space,
      parent: r.parent,
      runnerId: r.runnerId,
      usage: r.engineSettings,
      tools: r.tools,
      context: r.context,
      files: r.files,
      failureReply: r.failureReply,
      notice: r.notice,
      taskUrl: r.taskUrl,
      settingsUrl: r.settingsUrl,
    }),
    status: r.status,
    attempts: r.attempts,
    generation: r.generation,
    inboxSeq: r.inboxSeq,
    inboxAck: r.inboxAck < 0 ? undefined : { generation: r.generation, seq: r.inboxAck },
    result: r.result,
    error: r.error,
    fallbacks: r.fallbacks,
    tokens: r.tokens,
    handle: r.handle,
    tokenHash: r.tokenHash,
    lastSeenAt: optionalMs(r.lastSeenAt),
    logCursor: r.logCursor ?? undefined,
    logSeq: r.logSeq ?? undefined,
    logBytes: r.logBytes ?? undefined,
    logsComplete: r.logsComplete,
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

/** A sealed value as one opaque string: `plain.<base64>` or `<iv>.<tag>.<ciphertext>`. */
export function opaque(value: { iv: string; tag: string; ciphertext: string }): string {
  return value.iv === 'plain'
    ? `plain.${value.ciphertext}`
    : `${value.iv}.${value.tag}.${value.ciphertext}`;
}

/** The parts of an opaque sealed string. */
export function sealedParts(value: string): { iv: string; tag: string; ciphertext: string } {
  if (value.startsWith('plain.')) return { iv: 'plain', tag: '', ciphertext: value.slice(6) };
  const [iv, tag, ciphertext] = value.split('.');
  if (!iv || !tag || !ciphertext) throw new Error('Invalid encrypted secret');
  return { iv, tag, ciphertext };
}

/** A new secret row's id. */
export async function addSecret(db: Db, value: string): Promise<number> {
  const [row] = await db.insert(secret).values({ value }).returning({ id: secret.id });
  return row!.id;
}

export async function setSecret(db: Db, id: number, value: string): Promise<void> {
  await db.update(secret).set({ value }).where(eq(secret.id, id));
}

/** Deletes the secret rows of owners deleted in this transaction, except one a shared app still points at. */
export async function dropSecrets(db: Db, ids: Array<number | null | undefined>): Promise<void> {
  const found = ids.filter((id): id is number => typeof id === 'number');
  if (!found.length) return;
  await db
    .delete(secret)
    .where(
      sql`${inArray(secret.id, found)} and not exists (select 1 from ${integrationApp} where ${integrationApp.credentialsSecretId} = ${secret.id})`,
    );
}

/** A row's JSON with its secret row's value under `secret`, for one statement reads. */
export const withSecret = (row: SQL, value: SQL) =>
  sql`${row} || jsonb_strip_nulls(jsonb_build_object('secret', ${value}))`;

/** A finished task's usage row, as the `usage` kind lists it; undefined while it has not run. */
export function usageRecord(
  r: Pick<
    typeof task.$inferSelect,
    | 'publicId'
    | 'agent'
    | 'source'
    | 'event'
    | 'engine'
    | 'model'
    | 'credential'
    | 'runnerMs'
    | 'usageTokens'
    | 'finishedAt'
  >,
  installationKey: string | null,
): UsageRecord | undefined {
  if (r.runnerMs === null || !r.finishedAt) return undefined;
  return defined({
    installationId: installationKey,
    taskId: r.publicId,
    agent: r.agent,
    target: usageTarget({ event: r.event ?? undefined, source: r.source }),
    engine: r.engine,
    model: r.model,
    credential: r.credential ?? 'unknown',
    runnerElapsedMs: r.runnerMs,
    tokens: r.usageTokens,
    at: ms(r.finishedAt),
  });
}

export const statePrefix = (organizationId: string, kind: string) =>
  `o:${JSON.stringify([organizationId, kind])}:`;
export const stateKey = (organizationId: string, kind: string, id: string) =>
  statePrefix(organizationId, kind) + id;

export async function rows<T>(
  db: Pick<import('../client').Db, 'execute'>,
  statement: SQL,
): Promise<T[]> {
  const result = (await db.execute(statement)) as unknown as T[] | { rows: T[] };
  return Array.isArray(result) ? result : result.rows;
}
