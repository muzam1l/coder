/** The task kinds: `task`, `history`, `tasklog`, `inbox`, `usage`, and the `delivery` rows that expire. */
import { and, asc, eq, gt, sql } from 'drizzle-orm';

import type { TaskHistory, TaskLogLine, TaskStatus, UsageRecord } from '../../types';
import { task, taskHistory, taskInbox, taskLog, usage } from '../schema';
import type { DrizzleStore } from '../store';
import { reviewKey } from '../../../tasks/queue';
import {
  app,
  UNSCOPED_ORGANIZATION,
  date,
  defined,
  install,
  ms,
  taskRecord,
  storedTaskContext,
  type Kind,
} from './shared';

export function tasks(s: DrizzleStore): Kind<TaskStatus> {
  const t = task;
  return {
    key: t.publicId,
    rows: async (where, limit) => {
      const q = s.db
        .select()
        .from(t)
        .where(and(s.mine(t.organizationId), where))
        .orderBy(asc(t.publicId));
      const rows = await (limit === undefined ? q : q.limit(limit));
      return rows.map(r => ({ id: r.publicId, value: taskRecord(r) }));
    },
    put: async (id, value, _expiresAt, opts = {}) => {
      const { task: j } = value;
      const row = {
        source: j.source,
        status: value.status,
        agent: j.agent,
        flow: j.flow,
        reviewKey: reviewKey(j) ?? null,
        runner: j.runner,
        permissions: j.permissions ?? null,
        appId: j.event
          ? sql`(select id from ${app} where organization_id in (${s.organizationId}, ${UNSCOPED_ORGANIZATION}) and key = ${j.event.appId} order by organization_id desc limit 1)`
          : null,
        installationId: j.event
          ? sql`(select id from ${install} where organization_id = ${s.organizationId} and key = ${`${j.event.appId}:${j.event.installationId}`})`
          : null,
        event: j.event ?? null,
        prompt: j.prompt ?? null,
        args: j.args ?? null,
        mcp: j.mcp ?? null,
        author: j.author ?? null,
        definition: j.definition,
        credential: j.credential ?? null,
        requester: j.requester ?? null,
        runnerId: j.runnerId ?? null,
        usage: j.usage ?? null,
        tools: j.tools,
        toolScopes: j.toolScopes ?? null,
        context:
          value.logsComplete === undefined
            ? (storedTaskContext(j) ?? null)
            : {
                ...storedTaskContext(j),
                runnerLogs: {
                  complete: value.logsComplete,
                  handle: value.handle,
                  attempts: value.attempts,
                  generation: value.generation ?? 0,
                },
              },
        files: j.files ?? null,
        result: value.result ?? null,
        error: value.error ?? null,
        tokens: value.tokens ?? null,
        handle: value.handle ?? null,
        tokenHash: value.tokenHash ?? null,
        lastSeenAt: value.lastSeenAt === undefined ? null : date(value.lastSeenAt),
        logCursor: value.logCursor ?? null,
        logSeq: value.logSeq ?? null,
        logBytes: value.logBytes ?? null,
        archivedAt: value.archivedAt === undefined ? null : date(value.archivedAt),
        approval: value.approval ?? null,
        answer: value.answer ?? null,
        attempts: value.attempts,
        generation: value.generation ?? 0,
        inboxSeq: value.inboxSeq ?? -1,
        inboxAck: value.inboxAck?.generation === (value.generation ?? 0) ? value.inboxAck.seq : -1,
        createdAt: date(value.createdAt),
        startedAt: value.startedAt === undefined ? null : date(value.startedAt),
        finishedAt: value.finishedAt === undefined ? null : date(value.finishedAt),
        cancelRequestedAt:
          value.cancelRequestedAt === undefined ? null : date(value.cancelRequestedAt),
        updatedAt: date(value.updatedAt),
      };
      await s.db
        .insert(t)
        .values({ organizationId: s.organizationId, publicId: id, ...row })
        .onConflictDoUpdate({
          target: [t.organizationId, t.publicId],
          set: {
            ...row,
            archivedAt: opts.unarchive
              ? row.archivedAt
              : sql`coalesce(${t.archivedAt}, ${row.archivedAt})`,
          },
        });
    },
    delete: async id => {
      await s.db.delete(t).where(and(s.mine(t.organizationId), eq(t.publicId, id)));
    },
  };
}

export async function historySummaries(
  s: DrizzleStore,
  id: string,
): Promise<Array<Omit<TaskHistory, 'data' | 'state'>>> {
  const rows = await s.db
    .select({
      engine: taskHistory.engine,
      conversation: taskHistory.conversation,
      savedAt: taskHistory.savedAt,
    })
    .from(taskHistory)
    .innerJoin(task, eq(task.id, taskHistory.taskId))
    .where(
      and(s.mine(taskHistory.organizationId), s.mine(task.organizationId), eq(task.publicId, id)),
    )
    .orderBy(asc(taskHistory.savedAt));

  return rows.map(row => ({ ...row, savedAt: ms(row.savedAt) }));
}

export function histories(s: DrizzleStore): Kind<TaskHistory> {
  const t = taskHistory;
  const key = sql<string>`${task.publicId} || ':' || ${t.conversation}`;
  const parts = (id: string) => [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  return {
    key,
    where: ({ id, prefix }) => {
      const [publicId, conversation] = parts(id ?? prefix ?? '');
      return and(
        s.mine(task.organizationId),
        eq(task.publicId, publicId!),
        id === undefined ? undefined : eq(t.conversation, conversation!),
      )!;
    },
    rows: async (where, limit) => {
      const q = s.db
        .select({ row: t, key })
        .from(t)
        .innerJoin(task, eq(task.id, t.taskId))
        .where(and(s.mine(t.organizationId), where))
        .orderBy(asc(t.savedAt));
      const rows = await (limit === undefined ? q : q.limit(limit));
      return rows.map(({ row, key: id }) => ({
        id,
        value: defined({
          engine: row.engine,
          conversation: row.conversation,
          data: row.data,
          state: row.state,
          savedAt: ms(row.savedAt),
        }),
      }));
    },
    put: async (id, value) => {
      const row = {
        engine: value.engine,
        data: value.data,
        state: value.state ?? null,
        savedAt: date(value.savedAt),
      };
      await s.db
        .insert(t)
        .values({
          organizationId: s.organizationId,
          taskId: sql`(select id from ${task} where organization_id = ${s.organizationId} and public_id = ${parts(id)[0]})`,
          conversation: value.conversation,
          ...row,
        })
        .onConflictDoUpdate({ target: [t.taskId, t.conversation], set: row });
    },
    delete: async id => {
      const [publicId, conversation] = parts(id);
      const taskId = sql`(select id from ${task} where organization_id = ${s.organizationId} and public_id = ${publicId})`;
      await s.db.delete(t).where(and(eq(t.taskId, taskId), eq(t.conversation, conversation!)));
    },
  };
}

export function logs(s: DrizzleStore): Kind<Omit<TaskLogLine, 'seq'>> {
  const t = taskLog;
  const key = sql`${task.publicId} || ':' || lpad(${t.seq}::text, 6, '0')`;
  return {
    key,
    split: (publicId, seq, exact) =>
      and(
        s.mine(task.organizationId),
        eq(task.publicId, publicId),
        seq === undefined ? undefined : exact ? eq(t.seq, seq) : gt(t.seq, seq),
      )!,
    rows: async (where, limit) => {
      const q = s.db
        .select({ row: t, key })
        .from(t)
        .innerJoin(task, eq(task.id, t.taskId))
        .where(and(s.mine(t.organizationId), where))
        .orderBy(asc(task.publicId), asc(t.seq));
      const rows = await (limit === undefined ? q : q.limit(limit));
      return rows.map(({ row: r, key: id }) => ({
        id: id as string,
        value: { at: ms(r.at), level: r.level, line: r.line },
      }));
    },
    put: async (id, value) => {
      const split = id.lastIndexOf(':');
      const row = {
        at: date(value.at),
        level: value.level,
        line: value.line,
      };
      await s.db
        .insert(t)
        .values({
          organizationId: s.organizationId,
          taskId: sql`(select id from ${task} where organization_id = ${s.organizationId} and public_id = ${id.slice(0, split)})`,
          seq: Number(id.slice(split + 1)),
          ...row,
        })
        .onConflictDoUpdate({ target: [t.taskId, t.seq], set: row });
    },
    delete: async id => {
      const split = id.lastIndexOf(':');
      const taskId = sql`(select id from ${task} where organization_id = ${s.organizationId} and public_id = ${id.slice(0, split)})`;
      await s.db.delete(t).where(and(eq(t.taskId, taskId), eq(t.seq, Number(id.slice(split + 1)))));
    },
  };
}

export function inboxes(s: DrizzleStore): Kind<{
  seq: number;
  generation: number;
  at: number;
  kind: 'steer' | 'ask' | 'approve' | 'cancel';
  value: unknown;
}> {
  const t = taskInbox;
  const key = sql`${task.publicId} || ':' || lpad(${t.seq}::text, 8, '0')`;
  return {
    key,
    split: (publicId, seq, exact) =>
      and(
        s.mine(task.organizationId),
        eq(task.publicId, publicId),
        seq === undefined ? undefined : exact ? eq(t.seq, seq) : gt(t.seq, seq),
      )!,
    rows: async (where, limit) => {
      const q = s.db
        .select({ row: t, key })
        .from(t)
        .innerJoin(task, eq(task.id, t.taskId))
        .where(and(s.mine(t.organizationId), where))
        .orderBy(asc(task.publicId), asc(t.seq));
      const rows = await (limit === undefined ? q : q.limit(limit));
      return rows.map(({ row, key: id }) => ({
        id: id as string,
        value: {
          seq: row.seq,
          generation: row.generation,
          at: ms(row.at),
          kind: row.kind,
          value: row.value,
        },
      }));
    },
    put: async (id, value) => {
      const split = id.lastIndexOf(':');
      await s.db.insert(t).values({
        organizationId: s.organizationId,
        taskId: sql`(select id from ${task} where organization_id = ${s.organizationId} and public_id = ${id.slice(0, split)})`,
        seq: value.seq,
        generation: value.generation,
        kind: value.kind,
        value: value.value,
        at: date(value.at),
      });
    },
    delete: async id => {
      const split = id.lastIndexOf(':');
      const taskId = sql`(select id from ${task} where organization_id = ${s.organizationId} and public_id = ${id.slice(0, split)})`;
      await s.db.delete(t).where(and(eq(t.taskId, taskId), eq(t.seq, Number(id.slice(split + 1)))));
    },
  };
}

export function usages(s: DrizzleStore): Kind<UsageRecord> {
  const t = usage;
  return {
    key: task.publicId,
    rows: async (where, limit) => {
      const q = s.db
        .select({ row: t, taskId: task.publicId, installationId: install.key })
        .from(t)
        .innerJoin(task, eq(task.id, t.taskId))
        .leftJoin(install, eq(install.id, t.installationId))
        .where(and(s.mine(t.organizationId), where))
        .orderBy(asc(task.publicId));
      const rows = await (limit === undefined ? q : q.limit(limit));
      return rows.map(({ row: r, taskId, installationId }) => ({
        id: taskId,
        value: defined({
          installationId,
          taskId,
          agent: r.agent,
          target: r.target,
          engine: r.engine,
          model: r.model,
          credential: r.credential,
          runnerElapsedMs: r.runnerMs,
          tokens: r.tokens,
          at: ms(r.at),
        }),
      }));
    },
    put: async (id, value) => {
      const taskId = sql`(select id from ${task} where organization_id = ${s.organizationId} and public_id = ${id})`;
      const row = {
        installationId: value.installationId
          ? sql`(select id from ${install} where organization_id = ${s.organizationId} and key = ${value.installationId})`
          : null,
        agent: value.agent,
        target: value.target,
        engine: value.engine ?? null,
        model: value.model ?? null,
        credential: value.credential,
        runnerMs: value.runnerElapsedMs,
        tokens: value.tokens ?? null,
        at: date(value.at),
        updatedAt: s.at(),
      };
      await s.db
        .insert(t)
        .values({ organizationId: s.organizationId, taskId, ...row })
        .onConflictDoUpdate({ target: t.taskId, set: row });
    },
    delete: async id => {
      const taskId = sql`(select id from ${task} where organization_id = ${s.organizationId} and public_id = ${id})`;
      await s.db.delete(t).where(eq(t.taskId, taskId));
    },
  };
}
