/** The task kinds: `task`, `tasklog`, `inbox`, `usage`, and the `delivery` and `note` rows that expire. */
import { and, asc, eq, gt, sql } from 'drizzle-orm';

import type { TaskLogLine, TaskStatus, UsageRecord } from '../../types';
import { task, taskInbox, taskLog, usage } from '../schema';
import type { DrizzleStore } from '../store';
import {
  appRowId,
  date,
  defined,
  install,
  installationRowId,
  ms,
  taskRecord,
  taskRowId,
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
        runner: j.runner,
        permissions: j.permissions ?? null,
        appId: j.event ? await appRowId(s, j.event.appId) : null,
        installationId: j.event
          ? await installationRowId(s, `${j.event.appId}:${j.event.installationId}`)
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
        context: j.context ?? null,
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
          taskId: await taskRowId(s, id.slice(0, split)),
          seq: Number(id.slice(split + 1)),
          ...row,
        })
        .onConflictDoUpdate({ target: [t.taskId, t.seq], set: row });
    },
    delete: async id => {
      const split = id.lastIndexOf(':');
      const taskId = await taskRowId(s, id.slice(0, split)).catch(() => undefined);
      if (taskId !== undefined)
        await s.db
          .delete(t)
          .where(and(eq(t.taskId, taskId), eq(t.seq, Number(id.slice(split + 1)))));
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
        taskId: await taskRowId(s, id.slice(0, split)),
        seq: value.seq,
        generation: value.generation,
        kind: value.kind,
        value: value.value,
        at: date(value.at),
      });
    },
    delete: async id => {
      const split = id.lastIndexOf(':');
      const taskId = await taskRowId(s, id.slice(0, split)).catch(() => undefined);
      if (taskId !== undefined)
        await s.db
          .delete(t)
          .where(and(eq(t.taskId, taskId), eq(t.seq, Number(id.slice(split + 1)))));
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
      const taskId = await taskRowId(s, id);
      const row = {
        installationId: value.installationId
          ? await installationRowId(s, value.installationId)
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
      const taskId = await taskRowId(s, id).catch(() => undefined);
      if (taskId !== undefined) await s.db.delete(t).where(eq(t.taskId, taskId));
    },
  };
}
