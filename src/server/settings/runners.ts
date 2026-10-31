import path from 'node:path';
import * as z from 'zod/mini';
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import {
  type RunnerKind,
  type RunnerRow,
  type RunnerSpec,
  type RunnerTest,
} from '../../client/types';
import type { AgentTask } from '../../agent/types';
import { scoped, type ServerContext } from '../context';
import { type Params } from '../routes/match';
import { randomBytes } from 'node:crypto';
import { type RunnerRecord, type Store } from '../store/types';
import { decryptSecret, encryptSecret } from '../store/secrets';
import { RunnerCheckError } from '../runners';
import {
  githubRepos,
  githubRepoToken,
  recordRunner,
  runnerAccess,
  serverRunnerId,
  taskRunner,
  visibleRunner,
} from '../runners/select';
import { ACTIVE_STATES } from '../tasks/queue';
import { plansUrl, usageLimits, UsageLimitError } from '../tasks/usage';
import { workspaceAdmin } from '../routes/guards';
import { json } from '../routes/http';
import { safeEqual, sha256 } from '../../utils/crypto';
import { checkHttp, HttpRunner, validateHttpConfig } from '../runners/kinds/http';
import { RUNNER_IMAGE } from '../runners/package';
import { checkDocker, validateDockerConfig } from '../runners/kinds/docker';
import {
  checkGithubActions,
  ensureWorkflow,
  validateGithubActionsConfig,
  WORKFLOW_FILE,
} from '../runners/kinds/github-actions';
import {
  checkVercelSandbox,
  DEFAULT_PROJECT,
  resolveVercelScope,
  vercelOptions,
} from '../runners/kinds/vercel-sandbox';

function dockerAvailable(): boolean {
  return (process.env.PATH ?? '').split(path.delimiter).some(dir => {
    try {
      const file = path.join(dir, 'docker');
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

function runnerCatalog(ctx: ServerContext): RunnerSpec[] {
  const local = Boolean(ctx.local);
  const docker = local && dockerAvailable();
  const admin = workspaceAdmin(ctx);
  return [
    {
      kind: 'local-docker',
      name: 'Docker on the server',
      description: 'Run each task in a Docker container.',
      connect: 'fields',
      help: 'Each task runs in a fresh container on this server, using the Docker installed here. Leave fields empty for the defaults.',
      fields: [
        {
          key: 'image',
          label: 'Image',
          placeholder: RUNNER_IMAGE,
          hint: 'Needs Bun, Node, Git, curl, tar, Claude Code, Codex and GitHub MCP server.',
          optional: true,
        },
        { key: 'memory', label: 'Memory limit', placeholder: '4g', optional: true },
        { key: 'cpus', label: 'CPU limit', placeholder: '2', optional: true },
      ],
      available: docker,
      ...(!docker
        ? { reason: local ? 'Docker is not on PATH.' : 'Available on a local server only.' }
        : {}),
    },
    {
      kind: 'vercel-sandbox',
      name: 'Vercel Sandbox',
      description: 'Run tasks in an isolated sandbox.',
      connect: 'fields',
      help: 'Each task runs in a fresh Vercel Sandbox, billed to your Vercel team. Create a token scoped to that team, then pick its team and project here.',
      link: 'https://vercel.com/account/tokens',
      fields: [
        {
          key: 'token',
          label: 'Access token',
          placeholder: 'vcp_…',
          hint: 'scoped to a team',
          secret: true,
        },
        {
          key: 'team',
          label: 'Team',
          placeholder: 'Your default team',
          hint: 'your default if empty',
          optional: true,
          listed: true,
        },
        {
          key: 'projectId',
          label: 'Project',
          placeholder: DEFAULT_PROJECT,
          hint: 'created in that team if missing',
          optional: true,
          listed: true,
        },
        {
          key: 'region',
          label: 'Region',
          placeholder: 'iad1',
          hint: 'nearest if empty',
          optional: true,
        },
      ],
      available: true,
    },
    {
      kind: 'github-actions',
      name: 'GitHub Actions',
      description: 'Run tasks through a repository workflow.',
      connect: 'fields',
      help: 'Each task starts a workflow run in a repository GitHub is connected to (Settings → Connections). Coder adds the workflow file there and keeps it current.',
      fields: [
        {
          key: 'repo',
          label: 'Repository',
          placeholder: 'acme/runners',
          hint: 'owner/name',
          listed: true,
        },
        {
          key: 'workflow',
          label: 'Workflow file',
          placeholder: WORKFLOW_FILE,
          hint: 'added or updated on save',
          optional: true,
        },
        {
          key: 'token',
          label: 'Token',
          placeholder: 'github_pat_…',
          hint: admin ? 'if GitHub isn’t connected there' : 'Actions, Contents, Workflows write',
          secret: true,
          optional: admin,
        },
      ],
      available: true,
    },
    {
      kind: 'http',
      name: 'HTTP runner',
      description: 'Connect a runner at a public HTTPS address.',
      connect: 'fields',
      help: 'A server that speaks the runner protocol at a public HTTPS address and checks this secret on every request. For a computer running coder runner serve, use Your machine.',
      fields: [
        {
          key: 'url',
          label: 'Address',
          placeholder: 'https://runner.example.com',
          hint: 'its https address',
        },
        {
          key: 'secret',
          label: 'Secret',
          placeholder: 'the secret that server checks',
          hint: '32 characters or more',
          secret: true,
        },
      ],
      available: true,
    },
    {
      kind: 'local',
      name: local ? 'Another machine' : 'Your machine',
      description: local
        ? 'Pair another computer; it runs tasks with its own logins.'
        : 'Run tasks with your own machine and logins.',
      connect: 'pair',
      help: 'Tasks run code on that computer with its files and its Claude and Codex logins, not your CPU minutes. Pair only a computer you trust them with; it must stay on, with its tunnel open.',
      fields: [],
      available: true,
    },
  ];
}

const name = z.string().check(z.minLength(1), z.maxLength(80));

const scope = z.enum(['personal', 'workspace']);

const config = z.record(z.string(), z.string());

const addSchema = z.strictObject({
  kind: z.enum(['local', 'local-docker', 'github-actions', 'vercel-sandbox', 'http']),
  name,
  scope,
  config,
});

const optionsSchema = z.strictObject({ kind: addSchema.shape.kind, config });

const APP_ONLY_ADMIN = 'Only a workspace admin can use the GitHub connection. Add a token instead.';

const updateSchema = z.strictObject({
  name: z.optional(name),
  default: z.optional(z.literal(true)),
  config: z.optional(config),
});

function runnerRow(
  id: string,
  value: RunnerRecord,
  now: number,
  effective = value.default,
): RunnerRow {
  return {
    id,
    kind: value.kind,
    name: value.name,
    scope: value.scope,
    default: effective,
    online: value.lastSeen !== undefined && now - value.lastSeen < 5 * 60_000,
    ...(value.lastSeen !== undefined ? { lastSeen: value.lastSeen } : {}),
    config: value.config,
    createdAt: value.createdAt,
  };
}

const shown =
  (ctx: ServerContext, user?: string) =>
  ({ value }: { value: RunnerRecord }) =>
    visibleRunner(value, user) &&
    (ctx.local || (value.kind !== 'local' && value.kind !== 'local-docker'));

function runnerContext(ctx: ServerContext) {
  const user = ctx.session?.user.id;
  const now = (ctx.now ?? Date.now)();

  const canCreate = (value: RunnerRecord['scope']) =>
    value === 'workspace' ? workspaceAdmin(ctx) : Boolean(user);
  const rows = async (store: Store = ctx.store) =>
    (await store.list('runner')).filter(shown(ctx, user));
  const row = async (id: string, record: RunnerRecord, store: Store = ctx.store) => {
    const personal = (await rows(store)).some(
      ({ value }) => value.scope === 'personal' && value.default,
    );
    return runnerRow(id, record, now, record.default && (record.scope === 'personal' || !personal));
  };
  return { user, now, canCreate, rows, row };
}

export async function listRunners(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  return json({
    items: runnerItems(ctx, await ctx.store.list('runner'), (ctx.now ?? Date.now)()),
    catalog: runnerCatalog(ctx),
  });
}

/** The runners the requester sees out of the workspace's `records`, the server's own first. */
export function runnerItems(
  ctx: ServerContext,
  records: Array<{ id: string; value: RunnerRecord }>,
  now: number,
): RunnerRow[] {
  const rows = records.filter(shown(ctx, ctx.session?.user.id));
  const chosen =
    rows.find(({ value }) => value.scope === 'personal' && value.default) ??
    rows.find(({ value }) => value.default);
  const builtin: RunnerRow = {
    id: serverRunnerId(ctx),
    kind: ctx.config.runner,
    name: ctx.local ? 'This machine' : 'Default runner',
    scope: 'workspace',
    default: !chosen,
    online: true,
    config: {},
    createdAt: 0,
  };

  return [builtin, ...rows.map(({ id, value }) => runnerRow(id, value, now, id === chosen?.id))];
}

export async function createRunner(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const { user, now, canCreate, row } = runnerContext(ctx);
  {
    const parsed = addSchema.safeParse(await req.json().catch(() => undefined));
    if (!parsed.success) return json({ error: 'Invalid runner' }, 400);
    if (!canCreate(parsed.data.scope))
      return json({ error: 'This scope requires a member or workspace admin.' }, 403);

    const spec = runnerCatalog(ctx).find(s => s.kind === parsed.data.kind)!;
    if (!spec.available || spec.connect === 'pair')
      return json({ error: spec.reason ?? 'Pair this runner with runner serve.' }, 400);

    try {
      validateRunnerConfig(spec, parsed.data.config);
    } catch (error) {
      return json({ error: (error as Error).message }, 400);
    }

    // Adding reached the account when it resolved a Vercel team or checked a workflow file.
    let reached = parsed.data.kind === 'github-actions';
    if (parsed.data.kind === 'vercel-sandbox')
      try {
        const resolved = await resolveVercelScope(parsed.data.config, ctx.fetch ?? fetch);
        if (resolved) Object.assign(parsed.data.config, resolved);
        reached = Boolean(resolved);
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      }

    // The workspace's GitHub connection commits and dispatches with admin-granted permissions.
    if (parsed.data.kind === 'github-actions' && !parsed.data.config.token && !workspaceAdmin(ctx))
      return json({ error: APP_ONLY_ADMIN }, 403);
    if (parsed.data.kind === 'github-actions')
      try {
        const values = parsed.data.config;
        await ensureWorkflow(
          values,
          values.token || (await githubRepoToken(ctx, values.repo!, 'workflows')),
          ctx.fetch ?? fetch,
        );
      } catch (error) {
        return json({ error: (error as Error).message }, 400);
      }

    const fields = splitConfig(parsed.data.kind, parsed.data.config, ctx);
    const id = `rnr_${randomBytes(9).toString('base64url')}`;
    const record: RunnerRecord = {
      ...parsed.data,
      ...fields,
      owner: parsed.data.scope === 'personal' ? user : undefined,
      createdBy: user,
      default: false,
      createdAt: now,
      updatedAt: now,
      ...(reached ? { lastSeen: now } : {}),
    };

    return ctx.store.withAppLock(`runners:${ctx.organizationId}`, async store => {
      const denied = await runnerLimit(ctx, store);
      if (denied) return denied;
      await store.put('runner', id, record);

      return json(await row(id, record, store));
    });
  }
}

/** The choices a kind's listed fields offer for what its other fields reach, like a token's teams. */
export async function runnerOptions(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const parsed = optionsSchema.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) return json({ error: 'Invalid runner' }, 400);
  if (!ctx.session?.user && !workspaceAdmin(ctx)) return json({ error: 'Sign in first.' }, 403);
  const { kind, config: values } = parsed.data;

  try {
    if (kind === 'github-actions')
      return json({ repo: workspaceAdmin(ctx) ? await githubRepos(ctx) : [] });
    return json(
      kind === 'vercel-sandbox' && values.token
        ? await vercelOptions(values, ctx.fetch ?? fetch)
        : {},
    );
  } catch (error) {
    return json({ error: (error as Error).message }, 400);
  }
}

export async function checkRunner(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  if (id === serverRunnerId(ctx)) {
    return json(await testRunner(ctx));
  }

  const access = (existing?: RunnerRecord) => {
    const denied = runnerAccess(ctx, existing, 'change');
    return denied && json({ error: denied.error }, denied.status);
  };
  const existing = await ctx.store.get('runner', id);
  const denied = access(existing);
  if (denied) return denied;

  const result = await testRunner(ctx, existing);
  await ctx.store.withAppLock(`runners:${ctx.organizationId}`, async store => {
    const current = await store.get('runner', id);
    if (
      current &&
      current.secret === existing!.secret &&
      JSON.stringify(current.config) === JSON.stringify(existing!.config)
    )
      await store.put('runner', id, {
        ...current,
        lastSeen: result.ok ? (ctx.now ?? Date.now)() : undefined,
        updatedAt: (ctx.now ?? Date.now)(),
      });
  });

  return json(result);
}

/** Clears every other default in the scope `id` becomes the default of: its own scope and owner, or the workspace's for the built-in runner. */
export async function clearDefaults(
  store: Store,
  id: string,
  existing: RunnerRecord | undefined,
  now: number,
) {
  for (const other of await store.list('runner'))
    if (
      other.id !== id &&
      other.value.default &&
      other.value.scope === (existing?.scope ?? 'workspace') &&
      other.value.owner === existing?.owner
    )
      await store.put('runner', other.id, { ...other.value, default: false, updatedAt: now });
}

export async function updateRunner(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const { now, rows, row } = runnerContext(ctx);
  if (id === serverRunnerId(ctx)) {
    if (workspaceAdmin(ctx)) {
      const parsed = updateSchema.safeParse(await req.json().catch(() => undefined));
      if (!parsed.success || !parsed.data.default || parsed.data.name || parsed.data.config)
        return json({ error: 'Only the default can change for the built-in runner.' }, 400);
      await ctx.store.withAppLock(`runners:${ctx.organizationId}`, store =>
        clearDefaults(store, id, undefined, now),
      );

      const personal = (await rows()).some(
        ({ value }) => value.scope === 'personal' && value.default,
      );

      return json({
        id,
        kind: ctx.config.runner,
        name: ctx.local ? 'This machine' : 'Default runner',
        scope: 'workspace',
        default: !personal,
        online: true,
        config: {},
        createdAt: 0,
      });
    }

    return json({ error: 'The server default cannot be renamed or removed.' }, 403);
  }

  const access = (existing?: RunnerRecord) => {
    const denied = runnerAccess(ctx, existing, 'change');
    return denied && json({ error: denied.error }, denied.status);
  };

  return ctx.store.withAppLock(`runners:${ctx.organizationId}`, async store => {
    const existing = await store.get('runner', id);
    const denied = access(existing);
    if (denied || !existing) return denied!;
    {
      const parsed = updateSchema.safeParse(await req.json().catch(() => undefined));
      if (!parsed.success || !Object.keys(parsed.data).length)
        return json({ error: 'Invalid runner update' }, 400);

      let fields = {};
      if (parsed.data.config) {
        const merged = {
          ...existing.config,
          ...decryptSecret<Record<string, string>>(ctx.config, existing.secret),
          ...parsed.data.config,
        };

        try {
          validateRunnerConfig(
            runnerCatalog(ctx).find(s => s.kind === existing.kind)!,
            merged,
          );
        } catch (error) {
          return json({ error: (error as Error).message }, 400);
        }
        if (existing.kind === 'github-actions' && !merged.token && !workspaceAdmin(ctx))
          return json({ error: APP_ONLY_ADMIN }, 403);
        fields = splitConfig(existing.kind, merged, ctx);
      }
      if (parsed.data.default) await clearDefaults(store, id, existing, now);

      const record = {
        ...existing,
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.default ? { default: true } : {}),
        ...fields,
        updatedAt: now,
      };
      await store.put('runner', id, record);

      return json(await row(id, record, store));
    }
  });
}

export async function deleteRunner(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  if (id === serverRunnerId(ctx)) {
    return json({ error: 'The server default cannot be renamed or removed.' }, 403);
  }

  const access = (existing?: RunnerRecord) => {
    const denied = runnerAccess(ctx, existing, 'change');
    return denied && json({ error: denied.error }, denied.status);
  };

  return ctx.store.withAppLock(`runners:${ctx.organizationId}`, async store => {
    const existing = await store.get('runner', id);
    const denied = access(existing);
    if (denied || !existing) return denied!;
    {
      const { active: count } = await (store.queue?.() ?? ctx.queue).counts(ctx.organizationId, {
        statuses: ACTIVE_STATES,
        runnerId: id,
      });
      if (count)
        return json(
          {
            error:
              count === 1
                ? '1 task still runs on this runner. Stop it or wait.'
                : `${count} tasks still run on this runner. Stop them or wait.`,
          },
          409,
        );
      await store.delete('runner', id);
      await store.delete('snapshot', deletedKey(id));
      ctx.settings?.runnerInstances?.delete(id);

      return json({ ok: true });
    }
  });
}

function splitConfig(kind: RunnerKind, config: Record<string, string>, ctx: ServerContext) {
  const secrets = new Set(
    runnerCatalog(ctx)
      .find(s => s.kind === kind)!
      .fields.filter(f => f.secret)
      .map(f => f.key),
  );
  const entries = Object.entries(config);
  return {
    config: Object.fromEntries(entries.filter(([key]) => !secrets.has(key))),
    secret: encryptSecret(
      ctx.config,
      Object.fromEntries(entries.filter(([key]) => secrets.has(key))),
    ),
  };
}

const pairSchema = z.strictObject({ name: z.optional(name), scope });

export interface PairingRecord {
  name?: string;
  scope: RunnerRecord['scope'];
  owner?: string;
  createdBy?: string;
  expiresAt: number;
}

async function runnerLimit(ctx: ServerContext, store: Store): Promise<Response | undefined> {
  const limit = (await usageLimits(ctx)).maxRunners;
  if (limit === undefined) return undefined;
  const used = (await store.list('runner')).length;
  if (used < limit) return undefined;
  const refused = new UsageLimitError(
    `This workspace has ${used} runners, its limit. Remove one to add another.`,
    plansUrl(ctx),
  );

  return json({ error: refused.message }, refused.status);
}

export async function pairRunner(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const { user, now, canCreate } = runnerContext(ctx);
  const parsed = pairSchema.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) return json({ error: 'Invalid pairing' }, 400);
  if (!canCreate(parsed.data.scope))
    return json({ error: 'This scope requires a member or workspace admin.' }, 403);

  const token = `${Buffer.from(ctx.organizationId).toString('base64url')}.${randomBytes(32).toString('base64url')}`;
  const expiresAt = now + 15 * 60000;
  await ctx.store.put(
    'snapshot',
    `runner-pair:${sha256(token)}`,
    {
      ...parsed.data,
      owner: parsed.data.scope === 'personal' ? user : undefined,
      createdBy: user,
      expiresAt,
    },
    { ttlMs: 15 * 60000 },
  );

  const address = ctx.config.publicUrl ?? url.origin;

  return json({
    token,
    expiresAt,
    command: `coder runner serve --url ${address} --token ${token} --runner-url <tunnel address>`,
  });
}

export const registration = z.strictObject({
  token: z.optional(z.string()),
  id: z.optional(z.string()),
  organizationId: z.optional(z.string()),
  name: z.optional(z.string().check(z.minLength(1), z.maxLength(80))),
  url: z.string(),
  secret: z.string().check(z.minLength(32)),
  offline: z.optional(z.boolean()),
  removed: z.optional(z.array(z.string())),
});

export async function registerRunner(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const parsed = registration.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) return json({ error: 'Invalid runner registration' }, 400);

  const input = parsed.data;

  try {
    new HttpRunner({ url: input.url, secret: input.secret });
  } catch {
    return json({ error: 'A public HTTPS runner URL is required' }, 400);
  }

  const organizationId = input.token
    ? Buffer.from(input.token.split('.')[0]!, 'base64url').toString()
    : input.organizationId;
  if (!organizationId || (organizationId !== ctx.organizationId && !ctx.scope))
    return json({ error: 'Invalid runner token' }, 401);
  ctx = scoped(ctx, organizationId);

  const now = (ctx.now ?? Date.now)();

  const registered = await ctx.store.withAppLock(`runners:${ctx.organizationId}`, async store => {
    let record: RunnerRecord;
    let id: string;
    if (input.token) {
      const key = `runner-pair:${sha256(input.token)}`;
      const pairing = await store.get<PairingRecord>('snapshot', key);
      if (!pairing || pairing.expiresAt <= now)
        return json({ error: 'Pairing token expired or already used' }, 401);
      const denied = await runnerLimit(ctx, store);
      if (denied) return denied;
      if (!(await store.take('snapshot', key)))
        return json({ error: 'Pairing token expired or already used' }, 401);
      id = `rnr_${randomBytes(9).toString('base64url')}`;
      record = {
        kind: 'http',
        name: pairing.name ?? input.name ?? 'Your machine',
        scope: pairing.scope,
        owner: pairing.owner,
        createdBy: pairing.createdBy,
        default: false,
        createdAt: now,
        updatedAt: now,
        ...splitConfig('http', { url: input.url, secret: input.secret }, ctx),
        lastSeen: now,
      };
    } else {
      id = input.id ?? '';

      const existing = await store.get('runner', id);
      if (
        !existing ||
        existing.kind !== 'http' ||
        !safeEqual(
          decryptSecret<Record<string, string>>(ctx.config, existing.secret).secret ?? '',
          input.secret,
        )
      )
        return json({ error: 'Invalid runner token' }, 401);
      record = {
        ...existing,
        config: { ...existing.config, url: input.url },
        lastSeen: input.offline ? undefined : now,
        updatedAt: now,
      };
    }
    await store.put('runner', id, record);
    const deleted = input.token ? [] : await deletedRunnerTasks(store, id, input.removed);

    return json({
      ...runnerRow(id, record, now),
      organizationId,
      ...(deleted.length ? { deleted } : {}),
    });
  });
  if (registered.ok) ctx.taskWatcher?.runnersChanged(ctx.organizationId);

  return registered;
}

export const deletedKey = (runnerId: string) => `runner-deleted:${runnerId}`;

/** A deleted task's work folder goes now where the server runs it; a registered runner hears of it at its next registration. */
export async function removeTaskWork(
  ctx: ServerContext,
  task: Pick<AgentTask, 'id' | 'runner' | 'runnerId'>,
  handle?: string,
): Promise<void> {
  if (task.runner !== 'http' || !task.runnerId) {
    await (await taskRunner(ctx, task))?.remove?.(task.id, handle);
    return;
  }
  const runnerId = task.runnerId;
  await ctx.store.withAppLock(`runners:${ctx.organizationId}`, async store => {
    const pending = await store.get<{ deletedTasks: string[] }>('snapshot', deletedKey(runnerId));
    await store.put('snapshot', deletedKey(runnerId), {
      deletedTasks: [...(pending?.deletedTasks ?? []), task.id],
    });
  });
}

/** The tasks deleted since a runner's last registration, less those it reports removed; call under the runners lock. */
export async function deletedRunnerTasks(
  store: Store,
  runnerId: string,
  removed: string[] = [],
): Promise<string[]> {
  const pending = await store.get<{ deletedTasks: string[] }>('snapshot', deletedKey(runnerId));
  const left = (pending?.deletedTasks ?? []).filter(id => !removed.includes(id));
  if (!pending || left.length === pending.deletedTasks.length) return left;
  if (left.length) await store.put('snapshot', deletedKey(runnerId), { deletedTasks: left });
  else await store.delete('snapshot', deletedKey(runnerId));

  return left;
}

export function validateRunnerConfig(spec: RunnerSpec, config: Record<string, string>): void {
  if (Object.keys(config).some(key => !spec.fields.some(field => field.key === key)))
    throw new Error('Unknown runner field');
  for (const field of spec.fields)
    if (!field.optional && !config[field.key]?.trim())
      throw new Error(`${field.label} is required`);
  if (spec.kind === 'http') validateHttpConfig(config);
  if (spec.kind === 'github-actions') validateGithubActionsConfig(config);
  if (spec.kind === 'local-docker') validateDockerConfig(config);
}

export async function testRunner(ctx: ServerContext, record?: RunnerRecord): Promise<RunnerTest> {
  const start = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RunnerCheckError('Runner check timed out'));
    }, ctx.runnerTimeoutMs ?? 5000);
  });
  try {
    const detail = await Promise.race([
      timeout,
      (async () => {
        const kind = record?.kind ?? ctx.config.runner;
        const config = record
          ? {
              ...record.config,
              ...decryptSecret<Record<string, string>>(ctx.config, record.secret),
            }
          : (ctx.config.runnerConfig ?? {});
        if (kind === 'local') {
          if (!ctx.local) throw new RunnerCheckError('Local runners require a local server');
          return 'This machine is available';
        }
        if (kind === 'http')
          return checkHttp(
            record ? recordRunner(ctx, record) : ctx.runners.http,
            controller.signal,
          );
        if (kind === 'local-docker') {
          if (!ctx.local) throw new RunnerCheckError('Docker runners require a local server');
          return checkDocker(ctx.runnerExec ?? execFile, controller.signal);
        }
        const token =
          kind === 'github-actions' && !config.token
            ? await githubRepoToken(ctx, String(config.repo), 'actions')
            : config.token;
        const request = async (url: string) => {
          const response = await (ctx.fetch ?? fetch)(url, {
            signal: controller.signal,
            redirect: 'manual',
            headers: {
              authorization: `Bearer ${token}`,
              accept: 'application/json',
              'user-agent': 'coder',
            },
          });
          if (!response.ok)
            throw new RunnerCheckError(`Runner check failed with HTTP ${response.status}`);
          return response;
        };
        if (kind === 'github-actions') return checkGithubActions(config, request);
        // Without a token the SDK signs in with the deployment's OIDC token, which the REST API rejects.
        if (!config.token) return 'Runs with this deployment’s Vercel sign-in';
        return checkVercelSandbox(config, request);
      })(),
    ]);
    return { ok: true, detail, ms: Date.now() - start };
  } catch (error) {
    const detail = error instanceof RunnerCheckError ? error.message : 'Runner check failed';
    return { ok: false, detail, ms: Date.now() - start };
  } finally {
    clearTimeout(timer!);
  }
}
