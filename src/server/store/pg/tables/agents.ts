/** The `agent` and `agentversion` kinds over their tables. */
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';

import type { AgentRecord, AgentVersionRecord, AgentPublication } from '../../types';
import { agent, agentVersion } from '../schema';
import type { DrizzleStore } from '../store';
import { agentRowId, agentValue, date, versionValue, type Kind } from './shared';

export function publishAgent(
  s: DrizzleStore,
  desired: AgentRecord,
  content: AgentVersionRecord,
): Promise<AgentPublication> {
  return s.db.transaction(async tx => {
    const [locked] = await tx
      .insert(agent)
      .values({
        organizationId: s.organizationId,
        slug: desired.id,
        name: desired.name,
        description: desired.description ?? null,
        source: desired.source,
        repo: desired.repo ?? null,
        path: desired.path ?? null,
        currentVersion: 0,
        createdAt: date(desired.createdAt),
        updatedAt: date(desired.updatedAt),
      })
      .onConflictDoUpdate({ target: [agent.organizationId, agent.slug], set: { slug: desired.id } })
      .returning();
    const existing = agentValue(locked!);
    // A fresh statement sees the version committed by a publisher we waited for.
    const [row] = existing.currentVersion
      ? await tx
          .select()
          .from(agentVersion)
          .where(
            and(
              eq(agentVersion.agentId, locked!.id),
              eq(agentVersion.version, existing.currentVersion),
            ),
          )
      : [];
    const current = row && versionValue(row, desired.id);
    const unchanged = Boolean(
      current &&
      isDeepStrictEqual(current.definition, content.definition) &&
      current.systemPrompt === content.systemPrompt &&
      isDeepStrictEqual(current.files, content.files),
    );
    const version = unchanged ? current! : { ...content, version: existing.currentVersion + 1 };
    let record: AgentRecord = {
      ...desired,
      currentVersion: version.version,
      createdAt: existing.createdAt,
      ...(existing.settings ? { settings: existing.settings } : {}),
      updatedAt: existing.updatedAt,
    };
    if (unchanged && isDeepStrictEqual(record, existing))
      return { record: existing, version, unchanged };
    record = { ...record, updatedAt: desired.updatedAt };
    const insert = unchanged
      ? sql``
      : sql`with published as (
      insert into ${agentVersion} (agent_id, version, definition, system_prompt, files, commit, imported_from, created_at)
      values (${locked!.id}, ${version.version}, ${JSON.stringify(version.definition)}::jsonb, ${version.systemPrompt},
        ${version.files ? JSON.stringify(version.files) : null}::jsonb, ${version.commit ?? null}, ${version.importedFrom}, ${date(version.createdAt).toISOString()}::timestamptz)
      returning version
    )`;
    await tx.execute(sql`${insert} update ${agent} set
      name = ${record.name}, description = ${record.description ?? null}, source = ${record.source},
      repo = ${record.repo ?? null}, path = ${record.path ?? null},
      current_version = ${unchanged ? sql`${version.version}` : sql`(select version from published)`}, updated_at = ${date(record.updatedAt).toISOString()}::timestamptz
      where id = ${locked!.id}`);
    return { record, version, unchanged };
  });
}

export function agents(s: DrizzleStore): Kind<AgentRecord> {
  const t = agent;
  return {
    key: t.slug,
    rows: async (where, limit) => {
      const q = s.db
        .select()
        .from(t)
        .where(and(s.mine(t.organizationId), where))
        .orderBy(asc(t.slug));
      const rows = await (limit === undefined ? q : q.limit(limit));
      return rows.map(r => ({ id: r.slug, value: agentValue(r) }));
    },
    put: async (id, value) => {
      const row = {
        name: value.name,
        description: value.description ?? null,
        source: value.source,
        repo: value.repo ?? null,
        path: value.path ?? null,
        currentVersion: value.currentVersion,
        settings: value.settings ?? null,
        createdAt: date(value.createdAt),
        updatedAt: date(value.updatedAt),
      };
      await s.db
        .insert(t)
        .values({ organizationId: s.organizationId, slug: id, ...row })
        .onConflictDoUpdate({ target: [t.organizationId, t.slug], set: row });
    },
    delete: async id => {
      await s.db.delete(t).where(and(s.mine(t.organizationId), eq(t.slug, id)));
    },
  };
}

/** Insert a version unless that number is taken, returning whether it was. */
export async function insertVersion(
  s: DrizzleStore,
  id: string,
  value: AgentVersionRecord,
): Promise<boolean> {
  const split = id.lastIndexOf(':');
  const rows = await s.db
    .insert(agentVersion)
    .values({
      agentId: await agentRowId(s, id.slice(0, split)),
      version: Number(id.slice(split + 1)),
      definition: value.definition,
      systemPrompt: value.systemPrompt,
      files: value.files ?? null,
      commit: value.commit ?? null,
      importedFrom: value.importedFrom,
      createdAt: date(value.createdAt),
    })
    .onConflictDoNothing()
    .returning({ id: agentVersion.id });
  return rows.length > 0;
}

export function agentVersions(s: DrizzleStore): Kind<AgentVersionRecord> {
  const t = agentVersion;
  const key = sql`${agent.slug} || ':' || lpad(${t.version}::text, 6, '0')`;
  return {
    key,
    split: (slug, version, exact) =>
      and(
        eq(agent.slug, slug),
        version === undefined ? undefined : exact ? eq(t.version, version) : gt(t.version, version),
      )!,
    rows: async (where, limit) => {
      const q = s.db
        .select({ row: t, slug: agent.slug, key })
        .from(t)
        .innerJoin(agent, eq(agent.id, t.agentId))
        .where(and(s.mine(agent.organizationId), where))
        .orderBy(asc(agent.slug), asc(t.version));
      const rows = await (limit === undefined ? q : q.limit(limit));
      return rows.map(({ row, slug, key: id }) => ({
        id: id as string,
        value: versionValue(row, slug),
      }));
    },
    put: async (id, value) => {
      await insertVersion(s, id, value);
    },
    delete: async id => {
      const split = id.lastIndexOf(':');
      const owner = await agentRowId(s, id.slice(0, split)).catch(() => undefined);
      if (owner !== undefined)
        await s.db
          .delete(t)
          .where(and(eq(t.agentId, owner), eq(t.version, Number(id.slice(split + 1)))));
    },
  };
}
