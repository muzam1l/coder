import path from 'node:path';
import * as z from 'zod/mini';
import { accessSync, constants, statSync } from 'node:fs';
import { type RunnerKind, type RunnerRow, type RunnerSpec } from '../../client/types';
import { scoped, type ServerContext } from '../context';
import { type Params } from '../routes/match';
import { randomBytes } from 'node:crypto';
import { type RunnerRecord, type Store } from '../store/types';
import { decryptSecret, encryptSecret } from '../store/secrets';
import { serverRunnerId, testRunner, validateRunnerConfig, visibleRunner } from '../runners';
import { ACTIVE_STATES } from '../tasks/queue';
import { workspaceAdmin } from '../routes/guards';
import { json } from '../routes/http';
import { safeEqual, sha256 } from '../../utils/crypto';
import { HttpRunner } from '../runners/http';

export function dockerAvailable(): boolean {
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

export function runnerCatalog(ctx: ServerContext): RunnerSpec[] {
  const local = Boolean(ctx.local);
  const docker = local && dockerAvailable();
  return [
    {
      kind: 'local',
      name: local ? 'Another machine' : 'Your machine',
      description: local
        ? 'Pair another computer; it runs tasks with its own logins.'
        : 'Run tasks with your own machine and logins.',
      connect: 'pair',
      fields: [],
      available: true,
    },
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
          placeholder: 'node:22',
          hint: 'node 20 or newer',
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
      help: 'Each task gets a fresh Vercel Sandbox. Create an access token at vercel.com/account/tokens with Sandbox access for the team that pays for it.',
      fields: [
        {
          key: 'token',
          label: 'Access token',
          placeholder: 'vcp_…',
          hint: 'with Sandbox access',
          secret: true,
        },
        {
          key: 'team',
          label: 'Team',
          placeholder: 'team_…',
          hint: 'VERCEL_TEAM_ID if empty',
          optional: true,
        },
        {
          key: 'projectId',
          label: 'Project',
          placeholder: 'prj_…',
          hint: 'VERCEL_PROJECT_ID if empty',
          optional: true,
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
      help: 'Each task starts a workflow run in a repository you choose. Save coder server workflow as .github/workflows/coder-agent.yml. It runs coder agent run --task; the token needs Actions read and write on that repository.',
      fields: [
        { key: 'repo', label: 'Repository', placeholder: 'acme/runners', hint: 'owner/name' },
        {
          key: 'workflow',
          label: 'Workflow file',
          placeholder: 'coder-agent.yml',
          hint: 'in .github/workflows',
        },
        {
          key: 'token',
          label: 'Token',
          placeholder: 'github_pat_…',
          hint: 'Actions read and write',
          secret: true,
        },
        {
          key: 'ref',
          label: 'Branch',
          placeholder: 'main',
          hint: 'default branch if empty',
          optional: true,
        },
      ],
      available: true,
    },
    {
      kind: 'http',
      name: 'HTTP runner',
      description: 'Connect a runner at a public HTTPS address.',
      connect: 'fields',
      help: 'A machine already running coder runner serve. Copy the address and secret it printed; pairing from the Another machine or Your machine option does this for you.',
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
          placeholder: 'printed by coder runner serve',
          hint: '32 characters or more',
          secret: true,
        },
      ],
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

const updateSchema = z.strictObject({
  name: z.optional(name),
  default: z.optional(z.literal(true)),
  config: z.optional(config),
});

export function runnerRow(
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

export function runnerContext(ctx: ServerContext) {
  const user = ctx.session?.user.id;
  const now = (ctx.now ?? Date.now)();

  const canCreate = (value: RunnerRecord['scope']) =>
    value === 'workspace' ? workspaceAdmin(ctx) : Boolean(user);
  const rows = async (store: Store = ctx.store) =>
    (await store.list('runner')).filter(
      ({ value }) =>
        visibleRunner(value, user) &&
        (ctx.local || (value.kind !== 'local' && value.kind !== 'local-docker')),
    );
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
  const id = params.id!;
  const { user, now, canCreate, rows, row } = runnerContext(ctx);
  const records = await rows();
  const chosen =
    records.find(({ value }) => value.scope === 'personal' && value.default) ??
    records.find(({ value }) => value.default);
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

  return json({
    items: [
      builtin,
      ...records.map(({ id, value }) => runnerRow(id, value, now, id === chosen?.id)),
    ],
    catalog: runnerCatalog(ctx),
  });
}

export async function createRunner(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const { user, now, canCreate, rows, row } = runnerContext(ctx);
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
    };
    await ctx.store.put('runner', id, record);

    return json(await row(id, record));
  }
}

export async function checkRunner(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const { user, now, canCreate, rows, row } = runnerContext(ctx);
  if (id === serverRunnerId(ctx)) {
    return json(await testRunner(ctx));
  }

  const access = (existing?: RunnerRecord) => {
    if (
      !existing ||
      !visibleRunner(existing, user) ||
      (!ctx.local && (existing.kind === 'local' || existing.kind === 'local-docker'))
    )
      return json({ error: 'Unknown runner' }, 404);
    if (existing.scope === 'workspace' && !workspaceAdmin(ctx))
      return json({ error: 'Only a workspace owner or admin can change this runner.' }, 403);
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

export async function updateRunner(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const { user, now, canCreate, rows, row } = runnerContext(ctx);
  if (id === serverRunnerId(ctx)) {
    if (workspaceAdmin(ctx)) {
      const parsed = updateSchema.safeParse(await req.json().catch(() => undefined));
      if (!parsed.success || !parsed.data.default || parsed.data.name || parsed.data.config)
        return json({ error: 'Only the default can change for the built-in runner.' }, 400);
      await ctx.store.withAppLock(`runners:${ctx.organizationId}`, async store => {
        for (const { id, value } of await store.list('runner'))
          if (value.scope === 'workspace' && value.default)
            await store.put('runner', id, { ...value, default: false, updatedAt: now });
      });

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
    if (
      !existing ||
      !visibleRunner(existing, user) ||
      (!ctx.local && (existing.kind === 'local' || existing.kind === 'local-docker'))
    )
      return json({ error: 'Unknown runner' }, 404);
    if (existing.scope === 'workspace' && !workspaceAdmin(ctx))
      return json({ error: 'Only a workspace owner or admin can change this runner.' }, 403);
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
        fields = splitConfig(existing.kind, merged, ctx);
      }
      if (parsed.data.default) {
        for (const other of await store.list('runner'))
          if (
            other.id !== id &&
            other.value.scope === existing.scope &&
            other.value.owner === existing.owner &&
            other.value.default
          )
            await store.put('runner', other.id, { ...other.value, default: false, updatedAt: now });
      }

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
  const { user, now, canCreate, rows, row } = runnerContext(ctx);
  if (id === serverRunnerId(ctx)) {
    return json({ error: 'The server default cannot be renamed or removed.' }, 403);
  }

  const access = (existing?: RunnerRecord) => {
    if (
      !existing ||
      !visibleRunner(existing, user) ||
      (!ctx.local && (existing.kind === 'local' || existing.kind === 'local-docker'))
    )
      return json({ error: 'Unknown runner' }, 404);
    if (existing.scope === 'workspace' && !workspaceAdmin(ctx))
      return json({ error: 'Only a workspace owner or admin can change this runner.' }, 403);
  };

  return ctx.store.withAppLock(`runners:${ctx.organizationId}`, async store => {
    const existing = await store.get('runner', id);
    const denied = access(existing);
    if (denied || !existing) return denied!;
    {
      const count = (await store.list('task')).filter(
        ({ value }) => value.task.runnerId === id && ACTIVE_STATES.includes(value.status),
      ).length;
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
      ctx.settings?.runnerInstances?.delete(id);

      return json({ ok: true });
    }
  });
}

export function splitConfig(kind: RunnerKind, config: Record<string, string>, ctx: ServerContext) {
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

export async function pairRunner(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const { user, now, canCreate, rows, row } = runnerContext(ctx);
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
    command: `coder runner serve --url ${address} --token ${token}`,
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

  return ctx.store.withAppLock(`runners:${ctx.organizationId}`, async store => {
    let record: RunnerRecord;
    let id: string;
    if (input.token) {
      const key = `runner-pair:${sha256(input.token)}`;
      const pairing = await store.get<PairingRecord>('snapshot', key);
      if (!pairing || pairing.expiresAt <= now || !(await store.take('snapshot', key)))
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

    return json({ ...runnerRow(id, record, now), organizationId });
  });
}
