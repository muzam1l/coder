import { type Params } from '../routes/match';
import { randomBytes } from 'node:crypto';
import { type ServerContext } from '../context';
import { json } from '../routes/http';
import { type AgentTask, type RunnerKind } from '../../agent/types';
import { decryptSecret, encryptCredential, encryptSecret } from '../store/secrets';
import { createTaskToken } from '../tasks/access';
import { type CredentialAccount } from './credentials';
import { type CallbackContext } from '../tasks/callbacks';
import { ENGINE_HOSTS } from '../runners/kinds/vercel-sandbox';

export async function createLogin(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const user = ctx.session!.user.id;
  const body = (await req.json().catch(() => ({}))) as {
    engine?: string;
  };
  const engine = body.engine ?? '';
  if (!ENGINES.has(engine) || !ctx.config.subscriptions?.[engine as LoginEngine])
    return json({ error: `Sign in with ${engine || 'that engine'} is off on this server.` }, 403);

  const runner = ctx.runners[ctx.config.runner];
  if (!runner || runner.kind === 'github-actions')
    return json({ error: `Sign-in cannot run on the ${ctx.config.runner} runner.` }, 409);

  const loginId = `login-${randomBytes(12).toString('base64url')}`;
  const token = createTaskToken(loginId, ctx.organizationId, 0);
  const login: EngineLogin = {
    owner: user,
    engine: engine as LoginEngine,
    state: 'starting',
    tokenHash: token.hash,
    runner: runner.kind,
    createdAt: now(ctx),
    expiresAt: now(ctx) + LOGIN_TTL_MS,
  };
  const active = await ctx.store.withAppLock(
    `login:${ctx.organizationId}:${user}:${engine}`,
    async store => {
      const active = (await store.list('login')).find(
        ({ value }) =>
          value.owner === user &&
          value.engine === engine &&
          value.state !== 'done' &&
          value.state !== 'failed' &&
          value.expiresAt > now(ctx),
      );
      if (!active) await saveLogin({ ...ctx, store }, loginId, login);
      return active;
    },
  );
  if (active) return json(view(active.id, active.value));

  let started: EngineLogin;

  try {
    // Runners only read the id, and the login's env tells the runner process what to do.
    // Its machine lives no longer than the sign-in.
    const handle = await runner.start(
      { id: loginId } as AgentTask,
      {
        CODER_SERVER: ctx.config.publicUrl ?? '',
        CODER_TASK_TOKEN: token.token,
        CODER_LOGIN: engine,
      },
      undefined,
      {
        timeoutMs: LOGIN_TTL_MS,
        hosts: [ENGINE_HOSTS[engine]!.api, ...ENGINE_HOSTS[engine]!.account],
      },
    );
    const current = await ctx.store.patchLogin(loginId, { handle }, { tokenHash: login.tokenHash });
    if (!current) {
      await runner.stop(handle).catch(() => {});

      return json({ error: 'This sign-in is gone. Start again.' }, 409);
    }
    started = current;
  } catch (error) {
    await ctx.store.delete('login', loginId);

    return json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }

  return json(view(loginId, started), 201);
}

export async function readLogin(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id ?? '';
  const login = id && !id.includes('/') ? await own(ctx, id) : undefined;
  return login
    ? json(view(id, login))
    : json({ error: 'This sign-in is gone. Start again.' }, 404);
}

export async function answerLogin(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id ?? '';
  const login = id && !id.includes('/') ? await own(ctx, id) : undefined;
  if (!login) return json({ error: 'This sign-in is gone. Start again.' }, 404);

  const body = (await req.json().catch(() => ({}))) as {
    code?: unknown;
  };
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (login.engine !== 'claude' || login.state !== 'open' || !code)
    return json({ error: 'This sign-in is not waiting for a code.' }, 409);

  const updated = await ctx.store.patchLogin(
    id,
    {
      state: 'verifying',
      input: encryptSecret(ctx.config, code),
    },
    { state: 'open', tokenHash: login.tokenHash },
  );
  if (!updated) return json({ error: 'This sign-in is not waiting for a code.' }, 409);

  return json({ ok: true });
}

export async function cancelLogin(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id ?? '';
  const login = id && !id.includes('/') ? await own(ctx, id) : undefined;
  if (!login) return json({ error: 'This sign-in is gone. Start again.' }, 404);
  await ctx.store.delete('login', id);
  if (login.handle) await ctx.runners[login.runner]?.stop(login.handle).catch(() => {});

  return json({ ok: true });
}

export type LoginEngine = 'claude' | 'codex';

export interface EngineLogin {
  owner: string;
  engine: LoginEngine;
  state: 'starting' | 'open' | 'verifying' | 'done' | 'failed';
  url?: string;
  /** The device code Codex shows. */
  code?: string;
  /** The code the user pasted for Claude, sealed until the runner takes it. */
  input?: string;
  error?: string;
  tokenHash: string;
  runner: RunnerKind;
  handle?: string;
  createdAt: number;
  expiresAt: number;
}

const LOGIN_TTL_MS = 10 * 60 * 1000;

const ENGINES = new Set<string>(['claude', 'codex']);

const now = (ctx: ServerContext) => (ctx.now ?? Date.now)();

function saveLogin(ctx: ServerContext, id: string, login: EngineLogin) {
  return ctx.store.put('login', id, login, {
    ttlMs: Math.max(1, login.expiresAt - now(ctx)),
  });
}

export interface LoginView {
  id: string;
  engine: LoginEngine;
  state: EngineLogin['state'];
  expiresAt: number;
  url?: string;
  code?: string;
  error?: string;
}

function view(id: string, login: EngineLogin): LoginView {
  return {
    id,
    engine: login.engine,
    state: login.state,
    expiresAt: login.expiresAt,
    ...(login.url ? { url: login.url } : {}),
    ...(login.code ? { code: login.code } : {}),
    ...(login.error ? { error: login.error } : {}),
  };
}

async function own(ctx: ServerContext, id: string): Promise<EngineLogin | undefined> {
  const login = await ctx.store.get<EngineLogin>('login', id);
  return login && login.owner === ctx.session?.user.id ? login : undefined;
}

/** Stops the machine a finished sign-in ran on; its result is already stored. */
function release(ctx: ServerContext, login: EngineLogin) {
  const stopping = login.handle && ctx.runners[login.runner]?.stop(login.handle);
  if (!stopping) return;
  const logged = stopping.catch(error =>
    console.error(
      `coder server: could not stop the machine of a finished ${login.engine} sign-in`,
      error,
    ),
  );
  ctx.waitUntil?.(logged);
}

type LoginCallback = {
  url?: unknown;
  code?: unknown;
  error?: unknown;
  result?: { env?: Record<string, string>; account?: CredentialAccount };
};

export async function takeLoginInput(
  req: Request,
  ctx: CallbackContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const login = await ctx.store.get('login', id);
  if (!login || login.tokenHash !== ctx.callbackLogin!.tokenHash)
    return new Response('Unauthorized', { status: 401 });
  if (!login.input) return json({});

  const updated = await ctx.store.patchLogin(
    id,
    { input: null },
    { input: login.input, tokenHash: login.tokenHash },
  );
  return json(updated ? { code: decryptSecret<string>(ctx.config, login.input) } : {});
}

export async function readLoginEngine(
  req: Request,
  ctx: CallbackContext,
  params: Params,
  url: URL,
): Promise<Response> {
  return json({ engine: ctx.callbackLogin!.engine });
}

export async function reportLogin(
  req: Request,
  ctx: CallbackContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  let login = ctx.callbackLogin!;
  const body = (await req.json().catch(() => ({}))) as LoginCallback;
  if (login.state === 'done' || login.state === 'failed') return json({ ok: true });

  const active = {
    state: ['starting', 'open', 'verifying'] as EngineLogin['state'][],
    tokenHash: login.tokenHash,
  };
  if (typeof body.error === 'string') {
    if (
      await ctx.store.patchLogin(id, { state: 'failed', error: body.error.slice(0, 500) }, active)
    )
      release(ctx, login);

    return json({ ok: true });
  }

  const env = body.result?.env;
  if (env) {
    const allowed = login.engine === 'claude' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'CODEX_AUTH_JSON';
    if (Object.keys(env).join() !== allowed || typeof env[allowed] !== 'string')
      return json({ error: 'Invalid sign-in result' }, 400);

    const account = body.result?.account;
    const completed = await ctx.store.completeLogin(id, login.tokenHash, {
      ...encryptCredential(ctx.config, { env }),
      createdAt: (ctx.now ?? Date.now)(),
      ...(account?.email || account?.plan
        ? {
            account: {
              ...(typeof account.email === 'string' ? { email: account.email } : {}),
              ...(typeof account.plan === 'string' ? { plan: account.plan } : {}),
            },
          }
        : {}),
    });
    if (!completed) return json({ error: 'This sign-in changed. Try again.' }, 409);

    release(ctx, login);

    return json({ ok: true });
  }

  const fields = {
    ...(typeof body.url === 'string' && /^https:\/\//.test(body.url) ? { url: body.url } : {}),
    ...(typeof body.code === 'string' ? { code: body.code.slice(0, 64) } : {}),
  };
  // A link means the engine waits for the user, again after a rejected code.
  const updated = await ctx.store.patchLogin(
    id,
    fields.url ? { ...fields, state: 'open' } : fields,
    active,
  );
  if (!updated) return json({ error: 'This sign-in changed. Try again.' }, 409);

  return json({ ok: true });
}
