/** The task kinds: `task`, `history`, `tasklog`, `inbox` and `usage`, the last read from finished task rows. */
import { and, asc, eq, gt, gte, isNotNull, lte, sql } from 'drizzle-orm';

import type { TaskHistory, TaskLogLine, TaskStatus, UsageRecord } from '../../types';
import { task, taskHistory, taskInbox, taskLog } from '../schema';
import type { DrizzleStore } from '../store';
import { reviewKey } from '../../../tasks/queue';
import { taskAudience } from '../../../tasks/access';
import { countTokens } from '../../../tasks/usage';
import { date, defined, install, ms, splitKey, taskRecord, usageRecord, type Kind } from './shared';

/** The internal id of one of this organization's tasks. */
const taskId = (s: DrizzleStore, publicId: string) =>
  sql`(select ${task.id} from ${task} where ${task.organizationId} = ${s.organizationId} and ${task.publicId} = ${publicId})`;

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
      const { audience, space } = taskAudience(j);
      const row = {
        source: j.source,
        status: value.status,
        agent: j.agent,
        flow: j.flow,
        reviewKey: reviewKey(j) ?? null,
        runnerKind: j.runner,
        access: j.access ?? null,
        installationId: j.event
          ? sql`(select id from ${install} where organization_id = ${s.organizationId} and key = ${`${j.event.appId}:${j.event.installationId}`})`
          : null,
        event: j.event ?? null,
        audience,
        space: space ?? null,
        parent: j.parent ?? null,
        connections: j.connections ?? null,
        engineChain: j.engineChain ?? null,
        engineCredentials: j.engineCredentials ?? null,
        name: j.name ?? null,
        cwd: j.cwd ?? null,
        prompt: j.prompt ?? null,
        args: j.args ?? null,
        mcp: j.mcp ?? null,
        appendSystem: j.appendSystem ?? null,
        addDirs: j.addDirs ?? null,
        author: j.author ?? null,
        definition: j.definition,
        credential: j.credential ?? null,
        requestedBy: j.requestedBy ?? null,
        runnerId: j.runnerId ?? null,
        engineSettings: j.usage ?? null,
        tools: j.tools,
        context: j.context ?? null,
        files: j.files ?? null,
        failureReply: j.failureReply ?? null,
        taskUrl: j.taskUrl ?? null,
        settingsUrl: j.settingsUrl ?? null,
        result: value.result ?? null,
        error: value.error ?? null,
        tokens: value.tokens ?? null,
        handle: value.handle ?? null,
        tokenHash: value.tokenHash ?? null,
        lastSeenAt: value.lastSeenAt === undefined ? null : date(value.lastSeenAt),
        logCursor: value.logCursor ?? null,
        logSeq: value.logSeq ?? null,
        logBytes: value.logBytes ?? null,
        logsComplete: value.logsComplete ?? null,
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
    .where(and(s.mine(task.organizationId), eq(task.publicId, id)))
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
        .where(where)
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
        .values({ taskId: taskId(s, parts(id)[0]!), conversation: value.conversation, ...row })
        .onConflictDoUpdate({ target: [t.taskId, t.conversation], set: row });
    },
    delete: async id => {
      const [publicId, conversation] = parts(id);
      await s.db
        .delete(t)
        .where(and(eq(t.taskId, taskId(s, publicId!)), eq(t.conversation, conversation!)));
    },
  };
}

/** One row holds the lines of one flush; reads unnest them, so the kind still lists one line per key. */
export function logs(s: DrizzleStore): Kind<Omit<TaskLogLine, 'seq'>> {
  const t = taskLog;
  const seq = sql<number>`(line->>'seq')::int`;
  const key = sql`${task.publicId} || ':' || lpad(${seq}::text, 6, '0')`;
  return {
    key,
    split: (publicId, from, exact) =>
      and(
        s.mine(task.organizationId),
        eq(task.publicId, publicId),
        from === undefined ? undefined : exact ? gte(t.seqTo, from) : gt(t.seqTo, from),
        from === undefined ? undefined : exact ? eq(seq, from) : gt(seq, from),
      )!,
    rows: async (where, limit) => {
      const q = s.db
        .select({ key, line: sql<TaskLogLine>`line` })
        .from(t)
        .innerJoin(task, eq(task.id, t.taskId))
        .innerJoin(sql`jsonb_array_elements(${t.lines}) line`, sql`true`)
        .where(where)
        .orderBy(asc(task.publicId), asc(seq));
      const rows = await (limit === undefined ? q : q.limit(limit));
      return rows.map(({ key: id, line }) => ({
        id: id as string,
        value: { at: line.at, level: line.level, line: line.line },
      }));
    },
    put: async (id, value) => {
      const [publicId, seq] = splitKey(id)!;
      await writeLogs(s, publicId, [{ seq, ...value }]);
    },
    delete: async id => {
      const [publicId, seq] = splitKey(id)!;
      await s.db
        .update(t)
        .set({
          lines: sql`(select coalesce(jsonb_agg(line), '[]'::jsonb) from jsonb_array_elements(${t.lines}) line where ${seq} <> ${seq})`,
        })
        .where(and(eq(t.taskId, taskId(s, publicId)), gte(t.seqTo, seq), lte(t.seqFrom, seq)));
    },
  };
}

/** Writes one flush of a task's lines as one row; a flush sent again replaces its row. */
export async function writeLogs(
  s: DrizzleStore,
  publicId: string,
  lines: TaskLogLine[],
): Promise<void> {
  if (!lines.length) return;
  await s.db
    .insert(taskLog)
    .values({
      taskId: taskId(s, publicId),
      seqFrom: lines[0]!.seq,
      seqTo: lines[lines.length - 1]!.seq,
      lines,
    })
    .onConflictDoUpdate({
      target: [taskLog.taskId, taskLog.seqFrom],
      set: { seqTo: sql`excluded.seq_to`, lines: sql`excluded.lines` },
    });
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
        .where(where)
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
      await s.db.insert(t).values({
        taskId: taskId(s, id.slice(0, id.lastIndexOf(':'))),
        seq: value.seq,
        generation: value.generation,
        kind: value.kind,
        value: value.value,
        at: date(value.at),
      });
    },
    delete: async id => {
      const [publicId, seq] = splitKey(id)!;
      await s.db.delete(t).where(and(eq(t.taskId, taskId(s, publicId)), eq(t.seq, seq)));
    },
  };
}

/** Finished tasks as usage rows; a write lands the cost on the task's row. */
export function usages(s: DrizzleStore): Kind<UsageRecord> {
  const t = task;
  return {
    key: t.publicId,
    rows: async (where, limit) => {
      const q = s.db
        .select({ row: t, installationKey: install.key })
        .from(t)
        .leftJoin(install, eq(install.id, t.installationId))
        .where(and(s.mine(t.organizationId), isNotNull(t.runnerMs), where))
        .orderBy(asc(t.publicId));
      const rows = await (limit === undefined ? q : q.limit(limit));
      return rows.flatMap(({ row, installationKey }) => {
        const value = usageRecord(row, installationKey);
        return value ? [{ id: row.publicId, value }] : [];
      });
    },
    put: async (id, value) => {
      // The memory queue keys a turn's usage `<task>:<generation>`; the row is the task's.
      const publicId = splitKey(id)?.[0] ?? id;
      await s.db
        .update(t)
        .set({
          engine: value.engine ?? null,
          model: value.model ?? null,
          runnerMs: value.runnerElapsedMs,
          tokenCount: countTokens(value.tokens),
          usageTokens: value.tokens ?? null,
          finishedAt: date(value.at),
        })
        .where(and(s.mine(t.organizationId), eq(t.publicId, publicId)));
    },
    delete: async id => {
      await s.db
        .update(t)
        .set({ engine: null, model: null, runnerMs: null, tokenCount: null, usageTokens: null })
        .where(and(s.mine(t.organizationId), eq(t.publicId, id)));
    },
  };
}
