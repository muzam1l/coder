/** What every table adapter shares: the `Kind` shape, column conversions, and id and secret lookups. */
import { and, eq, or, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

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

/** Postgres requests acquire their organization from a session, app, or task. */
export const UNSCOPED_ORGANIZATION = '';

export type Rows<T> = Array<{ id: string; value: T }>;

export interface Kind<T> {
  key: PgColumn | SQL;
  where?(options: { id?: string; prefix?: string; after?: string }): SQL;
  /** Column predicates for a `<parent>:<padded number>` key, so lookups use the indexes. */
  split?(parent: string, from?: number, exact?: boolean): SQL;
  rows(where: SQL | undefined, limit?: number): Promise<Rows<T>>;
  put(id: string, value: T, expiresAt: Date | null): Promise<void>;
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

/** A `task` row as the `TaskStatus` record the rest of the server reads. */
export function taskRecord(r: typeof task.$inferSelect): TaskStatus {
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
      author: r.author,
      definition: r.definition,
      credential: r.credential,
      requester: r.requester,
      runnerId: r.runnerId,
      usage: r.usage,
      tools: r.tools,
      toolScopes: r.toolScopes,
      context: r.context,
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

export async function appRowId(s: DrizzleStore, key: string): Promise<number> {
  const [row] = await s.db
    .select({ id: app.id })
    .from(app)
    .where(
      and(
        or(s.mine(app.organizationId), eq(app.organizationId, UNSCOPED_ORGANIZATION)),
        eq(app.key, key),
      ),
    );
  if (!row) throw new Error(`Unknown app "${key}".`);
  return row.id;
}

export async function agentRowId(s: DrizzleStore, slug: string): Promise<number> {
  const [row] = await s.db
    .select({ id: agent.id })
    .from(agent)
    .where(and(s.mine(agent.organizationId), eq(agent.slug, slug)));
  if (!row) throw new Error(`Unknown agent "${slug}".`);
  return row.id;
}

export async function installationRowId(s: DrizzleStore, key: string): Promise<number> {
  const [row] = await s.db
    .select({ id: install.id })
    .from(install)
    .where(and(s.mine(install.organizationId), eq(install.key, key)));
  if (!row) throw new Error(`Unknown installation "${key}".`);
  return row.id;
}

export async function taskRowId(s: DrizzleStore, publicId: string): Promise<number> {
  const [row] = await s.db
    .select({ id: task.id })
    .from(task)
    .where(and(s.mine(task.organizationId), eq(task.publicId, publicId)));
  if (!row) throw new Error(`Unknown task "${publicId}".`);
  return row.id;
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
