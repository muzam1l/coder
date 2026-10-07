import { type Params } from '../routes/match';
import { isDeepStrictEqual } from 'node:util';
import { assertNotReserved, agentsFromSources } from '../../agent/load';
import { parseAgentsUsage } from '../../agent/definition';
import { type ServerContext } from '../context';
import { getAgent, getVersion, publishAgent, setAgentSettings, toAgent } from './records';
import { updateApps } from './repo';
import { deleteLocalAgent, syncLocalAgents, writeLocalAgent } from '../store/local';
import { updateConfig } from '../settings/config';
import { json, notFound } from '../routes/http';
import { prepareAgent } from './catalog';

const FILE_LIMIT = 256 * 1024;

const FILE_COUNT_LIMIT = 100;

function validFiles(value: unknown): value is Record<string, string> {
  if (!value || Array.isArray(value) || typeof value !== 'object') return false;
  const entries = Object.entries(value);
  if (entries.length > FILE_COUNT_LIMIT) return false;
  let size = 0;
  for (const [name, content] of entries) {
    if (
      typeof content !== 'string' ||
      name.startsWith('/') ||
      name.includes('\\') ||
      name.includes('\0') ||
      name.split('/').includes('..') ||
      name === 'agent.json' ||
      name === 'system.md'
    )
      return false;
    size += Buffer.byteLength(name) + Buffer.byteLength(content);
  }
  return size <= FILE_LIMIT;
}

export async function updateSettings(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const slug = params.slug!;
  const versionNumber = params.version ? Number(params.version) : undefined;
  if (params.version && !/^\d+$/.test(url.pathname.split('/').at(-1)!)) return notFound();

  const { now, local, loadCurrent } = await prepareAgent(ctx, slug);
  const body = await req.json().catch(() => undefined);

  try {
    const parsed = parseAgentsUsage({ [slug]: body })[slug];
    if (!parsed || typeof parsed !== 'object') throw new Error('settings must be an object');

    const { record, version } = await loadCurrent();
    if (!record || !version) throw new Error(`No agent named "${slug}".`);
    toAgent({ ...record, settings: undefined }, version, parsed, ctx.integrations);
    if (ctx.local) {
      await updateConfig(ctx, config => {
        config.agents = { ...config.agents, [slug]: parsed };
      });
      await syncLocalAgents(ctx.store, ctx.local.cwd, ctx.integrations);

      return json(await getAgent(ctx.store, slug));
    }

    return json(await setAgentSettings(ctx.store, slug, parsed, (ctx.now ?? Date.now)()));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

export async function deleteAgent(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const slug = params.slug!;
  const versionNumber = params.version ? Number(params.version) : undefined;
  if (params.version && !/^\d+$/.test(url.pathname.split('/').at(-1)!)) return notFound();

  const { now, local, loadCurrent } = await prepareAgent(ctx, slug);
  const { record } = await loadCurrent();
  if (!record) return json({ error: `No agent named "${slug}"` }, 404);
  if (record.source === 'builtin')
    return json({ error: 'Built-in agents cannot be deleted.' }, 400);
  if (ctx.local && !(await deleteLocalAgent(ctx.local.cwd, ctx.integrations, slug)))
    return json({ error: `Delete .coder/agents/${slug} in the repo` }, 409);
  for (const { id } of await ctx.store.list('agentversion', { prefix: `${slug}:` }))
    await ctx.store.delete('agentversion', id);
  await ctx.store.delete('agent', slug);

  return json({ ok: true });
}

export async function publish(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const slug = params.slug!;
  const versionNumber = params.version ? Number(params.version) : undefined;
  if (params.version && !/^\d+$/.test(url.pathname.split('/').at(-1)!)) return notFound();

  const { now, local, loadCurrent } = await prepareAgent(ctx, slug);
  const body = (await req.json().catch(() => undefined)) as
    | {
        definition?: unknown;
        systemPrompt?: unknown;
        files?: unknown;
        name?: unknown;
        description?: unknown;
      }
    | undefined;
  if (
    !body ||
    typeof body.systemPrompt !== 'string' ||
    (body.files !== undefined && !validFiles(body.files)) ||
    (body.name !== undefined && typeof body.name !== 'string') ||
    (body.description !== undefined && typeof body.description !== 'string')
  )
    return json(
      {
        error: 'definition and systemPrompt are required; files must contain strings',
      },
      400,
    );

  try {
    assertNotReserved([slug]);

    const [validated] = agentsFromSources(
      {
        definitions: { [slug]: { json: body.definition, builtin: false } },
        usage: undefined,
      },
      ctx.integrations,
    );
    if (!validated) throw new Error(`No agent named "${slug}".`);

    const before = ctx.local ? await getAgent(ctx.store, slug) : undefined;
    const previous = ctx.local && before ? await getVersion(ctx.store, slug) : undefined;
    const files = body.files as Record<string, string> | undefined;
    if (ctx.local) {
      await writeLocalAgent(ctx.local.cwd, ctx.integrations, slug, {
        definition: {
          ...(body.definition as object),
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
        },
        systemPrompt: body.systemPrompt,
        ...(files ? { files } : {}),
      });
      await syncLocalAgents(ctx.store, ctx.local.cwd, ctx.integrations);
    }

    const published = ctx.local
      ? undefined
      : await publishAgent(
          ctx.store,
          {
            id: slug,
            name: body.name ?? validated.name,
            description: body.description ?? validated.definition.description,
            source: 'upload',
            definition: validated.definition,
            systemPrompt: body.systemPrompt,
            files,
            importedFrom: 'upload',
          },
          (ctx.now ?? Date.now)(),
        );
    const version = published?.version ?? (await getVersion(ctx.store, slug))!;
    const unchanged =
      published?.unchanged ??
      isDeepStrictEqual(previous && { ...previous, createdAt: 0 }, { ...version, createdAt: 0 });
    await updateApps(ctx, [version]);

    const record = published?.record ?? (await getAgent(ctx.store, slug))!;

    return json({
      ...record,
      definition: version.definition,
      version: version.version,
      unchanged,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}
