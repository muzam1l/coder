import { type Params } from '../routes/match';
import { isDeepStrictEqual } from 'node:util';
import { assertNotReserved, agentsFromSources, repoAgentOverride } from '../../agent/load';
import { parseAgentsUsage, usageEntry } from '../../agent/definition';
import { type ServerContext } from '../context';
import { getAgent, getVersion, publishAgent, setAgentSettings, toAgent } from './records';
import { syncApps } from './repo';
import { deleteLocalAgent, syncLocalAgents, writeLocalAgent } from '../store/local';
import { effectiveConfig, shownConfig, updateConfig } from '../settings/config';
import { modelName, splitEngineSpec } from '../../core/config';
import { resolveTaskOptions } from '../../core/dispatch';
import { modelProblem, personalOnly, resolveModels } from '../settings/credentials';
import { json } from '../routes/http';
import { prepareAgent } from './catalog';
import { chooseRunner } from '../runners/select';
import { CoderError } from '../../core/errors';
import type { AppSync } from '../../client/types';
import type { AgentUsage } from '../../agent/types';
import type { AgentRecord, AgentVersionRecord } from '../store/types';

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

/** The agent's apps after a publish: pushed to their platform, failed, or needing changes there by hand. */
async function publishedApps(ctx: ServerContext, version: AgentVersionRecord): Promise<AppSync[]> {
  return (await syncApps(ctx, [version])).flatMap(({ app, error, check }): AppSync[] => {
    const row = { id: app.id, integration: app.integration, name: app.name };
    if (error) return [{ ...row, error }];
    if (!check) return [{ ...row, updated: true }];

    return check.changed ? [{ ...row, drift: true }] : [];
  });
}

/** An agent's settings in the shape they are saved in: engine, model and effort resolved from its model spec or saved split, refused unless a workspace credential runs them or when its runner is unknown. */
export async function agentSettings(ctx: ServerContext, slug: string, body: unknown) {
  const usage = body && typeof body === 'object' ? usageEntry(body as AgentUsage) : body;
  const parsed = parseAgentsUsage({ [slug]: usage })[slug];
  if (!parsed || typeof parsed !== 'object') throw new Error('settings must be an object');
  if (parsed.model) {
    // The engine it runs on, with the model and effort as given.
    const typed = splitEngineSpec(parsed.model);
    const selected = resolveTaskOptions(
      { engine: parsed.engine, model: parsed.model, effort: parsed.effort },
      effectiveConfig(ctx, await shownConfig(ctx)),
    );
    parsed.engine = selected.engine;
    parsed.model = typed.model;
    parsed.effort = typed.effort ?? parsed.effort;
  }
  const problem = await modelProblem(ctx, parsed, Boolean(ctx.taskPrincipal), ctx.session?.user.id);
  if (problem) throw new Error(problem);
  if (parsed.runner)
    await chooseRunner(ctx, { requestedBy: ctx.session?.user.id, agent: parsed.runner });

  return parsed;
}

/** Saves an agent's settings, for the dashboard and an approved task change alike: the repo's config on a local server, else its record. */
export async function saveAgentSettings(ctx: ServerContext, slug: string, body: unknown) {
  const { loadCurrent } = await prepareAgent(ctx, slug);
  const { disabled, ...usage } = await agentSettings(ctx, slug, body);
  const settings = disabled ? { ...usage, disabled } : usage;

  const { record, version } = await loadCurrent();
  if (!record || !version) throw new Error(`No agent named "${slug}".`);
  toAgent({ ...record, settings: undefined }, version, usage, ctx.integrations);
  if (!ctx.local) return setAgentSettings(ctx.store, slug, settings, (ctx.now ?? Date.now)());

  const file = repoAgentOverride(ctx.local.cwd, slug, !!disabled);
  if (file)
    throw new CoderError(
      'server',
      `Agent "${slug}" is ${disabled ? 'enabled' : 'disabled'} by agents.${slug} in ${file}. Change it there.`,
      { status: 409 },
    );
  await updateConfig(ctx, config => {
    config.agents = { ...config.agents, [slug]: usageEntry(settings) };
  });
  await syncLocalAgents(ctx.store, ctx.local.cwd, ctx.integrations);

  return (await getAgent(ctx.store, slug))!;
}

export async function updateSettings(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const body = await req.json().catch(() => undefined);

  return saveAgentSettings(ctx, params.slug!, body).then(
    async record => json({ ...record, ...(await personalWarning(ctx, record)) }),
    (error: Error) =>
      json({ error: error.message }, error instanceof CoderError ? (error.status ?? 400) : 400),
  );
}

/** A saved model only the saver's own credential runs, as a warning for the save toast. */
async function personalWarning(ctx: ServerContext, record: AgentRecord) {
  const settings = record.settings ?? {};
  const viewer = ctx.session?.user.id;
  if (!viewer || (!settings.engine && !settings.model)) return {};
  const { models } = await resolveModels(ctx, settings, viewer);

  return personalOnly(models)
    ? {
        warning: `Only your personal credential runs ${modelName(models[0]!.option)}. Others fall back to the chain until a workspace credential runs it.`,
      }
    : {};
}

export async function deleteAgent(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const slug = params.slug!;
  const { loadCurrent } = await prepareAgent(ctx, slug);
  const { record } = await loadCurrent();
  if (!record) return json({ error: `No agent named "${slug}"` }, 404);
  if (record.source === 'builtin')
    return json({ error: 'Built-in agents cannot be deleted.' }, 400);
  if (ctx.local && !(await deleteLocalAgent(ctx.local.cwd, ctx.integrations, slug)))
    return json({ error: `Delete .coder/agents/${slug} in the repo` }, 409);
  await ctx.store.delete('agent', slug);

  return json({ ok: true });
}

/** An agent's uploaded contents: what a publish takes. */
export interface AgentUpload {
  definition?: unknown;
  systemPrompt?: unknown;
  files?: unknown;
  name?: unknown;
  description?: unknown;
}

/** Publishes an upload as the agent's next version, for the dashboard, the CLI and an approved task change alike; nothing new when unchanged. */
export async function publishUpload(
  ctx: ServerContext,
  slug: string,
  body: AgentUpload | undefined,
  expected?: Pick<AgentRecord, 'currentVersion'>,
) {
  await prepareAgent(ctx, slug);
  if (
    !body ||
    typeof body.systemPrompt !== 'string' ||
    (body.files !== undefined && !validFiles(body.files)) ||
    (body.name !== undefined && typeof body.name !== 'string') ||
    (body.description !== undefined && typeof body.description !== 'string')
  )
    throw new Error('definition and systemPrompt are required; files must contain strings');
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
          name: (body.name as string | undefined) ?? validated.name,
          description: (body.description as string | undefined) ?? validated.definition.description,
          source: 'upload',
          definition: validated.definition,
          systemPrompt: body.systemPrompt,
          files,
          importedFrom: 'upload',
        },
        (ctx.now ?? Date.now)(),
        expected,
      );
  if (!ctx.local && !published) return undefined;
  const version = published?.version ?? (await getVersion(ctx.store, slug))!;
  const unchanged =
    published?.unchanged ??
    isDeepStrictEqual(previous && { ...previous, createdAt: 0 }, { ...version, createdAt: 0 });
  const apps = await publishedApps(ctx, version);

  const record = published?.record ?? (await getAgent(ctx.store, slug))!;

  return { ...record, definition: version.definition, version: version.version, unchanged, apps };
}

export async function publish(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const body = (await req.json().catch(() => undefined)) as AgentUpload | undefined;

  return publishUpload(ctx, params.slug!, body).then(json, (error: Error) =>
    json({ error: error.message }, 400),
  );
}
