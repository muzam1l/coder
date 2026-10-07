import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import * as z from 'zod/mini';

import { CoderError } from '../core/dispatch';
import { rerunWith } from '../utils/process';
import type { ServerConfig } from './context';

const count = (fallback: number) =>
  z._default(z.coerce.number().check(z.int(), z.positive()), fallback);

const flag = z.pipe(
  z.optional(z.string()),
  z.transform(value => value === '1'),
);

const url = (valid: (url: URL) => boolean, message: string) =>
  z.string().check(
    z.overwrite(value => value.replace(/\/$/, '')),
    z.refine(value => URL.canParse(value), { error: 'must be a URL', abort: true }),
    z.refine(value => valid(new URL(value)), message),
  );

const emptyAsUnset = <T extends z.ZodMiniType>(schema: T) =>
  z.pipe(
    z.transform((value: unknown): unknown => value || undefined),
    schema,
  );

const jsonObject = z.pipe(
  z.string(),
  z.transform((value, ctx) => {
    try {
      const decoded: unknown = JSON.parse(value);
      if (decoded && !Array.isArray(decoded) && typeof decoded === 'object')
        return decoded as Record<string, unknown>;
    } catch {}
    ctx.issues.push({ code: 'custom', message: 'must be a JSON object', input: value });
    return z.NEVER;
  }),
);

const wularSchema = z.object({
  AUTH_WULAR_URL: z._default(
    url(
      url => url.protocol === 'https:' || url.hostname === 'localhost',
      'must use HTTPS unless it is localhost',
    ),
    'https://auth.wular.ai',
  ),
});

const schema = z.object({
  SERVER_LIMITS: emptyAsUnset(
    z.optional(
      z.pipe(
        jsonObject,
        z.strictObject({
          principalPerMinute: z.optional(z.number().check(z.int(), z.positive())),
          authPerMinute: z.optional(z.number().check(z.int(), z.positive())),
          registerPerMinute: z.optional(z.number().check(z.int(), z.positive())),
          ipPerMinute: z.optional(z.number().check(z.int(), z.positive())),
          pairingPerMinute: z.optional(z.number().check(z.int(), z.positive())),
          concurrentTasks: z.optional(z.number().check(z.int(), z.positive())),
        }),
      ),
    ),
  ),
  RUNNER: z.optional(z.enum(['local', 'local-docker', 'vercel-sandbox', 'github-actions', 'http'])),
  RUNNER_CONFIG: emptyAsUnset(z._default(jsonObject, {})),
  WORK_DIR: z.optional(z.string()),
  SERVER_ENCRYPTION_KEY: z.optional(z.string()),
  SERVER_ENCRYPTION_KEY_PREVIOUS: z.optional(z.string()),
  ADMIN_TOKEN: z.optional(z.string()),
  PUBLIC_URL: emptyAsUnset(
    z.optional(
      url(
        url => url.pathname === '/' && !url.search && !url.hash,
        'must be an origin, with no path, query or fragment',
      ),
    ),
  ),
  SERVER_NAME: z.optional(z.string().check(z.trim())),
  VERCEL_PROJECT_PRODUCTION_URL: z.optional(z.string()),
  VERCEL_URL: z.optional(z.string()),
  VERCEL: z.optional(z.string()),
  DATABASE_URL: z.optional(z.string()),
  POSTGRES_URL: z.optional(z.string()),
  DATABASE_POOL_MAX: z.optional(z.coerce.number().check(z.int(), z.positive())),
  DATABASE_IDLE_TIMEOUT: z.optional(z.coerce.number().check(z.int(), z.positive())),
  MAX_TASKS: z.optional(z.coerce.number().check(z.int(), z.positive())),
  MAX_QUEUED: count(1000),
  TASK_STALL: count(5 * 60 * 1000),
  TASK_ATTEMPTS: count(2),
  TASK_TIMEOUT: count(30 * 60 * 1000),
  CLAUDE_SUBSCRIPTIONS: flag,
  CODEX_SUBSCRIPTIONS: flag,
  SERVER_INTEGRATIONS: emptyAsUnset(z.optional(z.string())),
});

function parse<T>(target: z.ZodMiniType<T>, env: Record<string, string | undefined>): T {
  const parsed = target.safeParse(env);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw new CoderError(
    'invalid-option',
    `Invalid server configuration:${String(issue.path[0])} ${issue.message}`,
  );
}

/** Parse the server configuration without exposing unrelated host env vars. */
export function loadServerConfig(
  env: Record<string, string | undefined> = process.env,
  host: 'node' | 'vercel' = 'node',
): ServerConfig {
  const values = parse(schema, env);

  // Vercel's provisioned stores set POSTGRES_URL.
  const databaseUrl = values.DATABASE_URL ?? values.POSTGRES_URL;
  const store = databaseUrl ? 'postgres' : 'memory';
  if (store === 'postgres' && !values.SERVER_ENCRYPTION_KEY)
    throw new CoderError('invalid-option', 'SERVER_ENCRYPTION_KEY is required with DATABASE_URL');
  // On Vercel the deployment's own URL is the public one unless PUBLIC_URL says otherwise.
  const vercelUrl =
    host === 'vercel' ? (values.VERCEL_PROJECT_PRODUCTION_URL ?? values.VERCEL_URL) : undefined;
  const publicUrl = values.PUBLIC_URL ?? (vercelUrl ? `https://${vercelUrl}` : undefined);
  const wularUrl = store === 'postgres' ? parse(wularSchema, env).AUTH_WULAR_URL : undefined;

  return {
    runner: values.RUNNER ?? (host === 'vercel' || values.VERCEL ? 'vercel-sandbox' : 'local'),
    store,
    workDir: values.WORK_DIR ?? path.join(os.tmpdir(), 'coder'),
    ...(values.SERVER_ENCRYPTION_KEY ? { encryptionKey: values.SERVER_ENCRYPTION_KEY } : {}),
    ...(values.SERVER_ENCRYPTION_KEY_PREVIOUS
      ? { previousEncryptionKey: values.SERVER_ENCRYPTION_KEY_PREVIOUS }
      : {}),
    ...(values.ADMIN_TOKEN ? { adminToken: values.ADMIN_TOKEN } : {}),
    ...(publicUrl ? { publicUrl } : {}),
    ...(values.SERVER_NAME ? { name: values.SERVER_NAME } : {}),
    ...(databaseUrl
      ? {
          databaseUrl,
          databasePool: {
            max: values.DATABASE_POOL_MAX ?? (host === 'vercel' || values.VERCEL ? 2 : 10),
            idleTimeout:
              values.DATABASE_IDLE_TIMEOUT ?? (host === 'vercel' || values.VERCEL ? 30 : 240),
          },
        }
      : {}),
    runnerConfig: values.RUNNER_CONFIG,
    maxTasks: values.MAX_TASKS,
    limits: values.SERVER_LIMITS,
    maxQueued: values.MAX_QUEUED,
    taskTimeoutMs: values.TASK_TIMEOUT,
    taskStallMs: values.TASK_STALL,
    taskAttempts: values.TASK_ATTEMPTS,
    ...(values.CLAUDE_SUBSCRIPTIONS || values.CODEX_SUBSCRIPTIONS
      ? {
          subscriptions: {
            claude: values.CLAUDE_SUBSCRIPTIONS,
            codex: values.CODEX_SUBSCRIPTIONS,
          },
        }
      : {}),
    ...(wularUrl ? { auth: { wular: { url: wularUrl } } } : {}),
    ...(values.SERVER_INTEGRATIONS
      ? {
          integrations: values.SERVER_INTEGRATIONS.split(',')
            .map(id => id.trim())
            .filter(Boolean),
        }
      : {}),
  };
}

declare const Bun: unknown;

function bunServerError(): CoderError {
  return new CoderError(
    'invalid-option',
    'The Coder server needs Bun; the CLI itself runs on Node.',
    {
      hint: [
        process.platform === 'win32'
          ? 'Install Bun: powershell -c "irm bun.sh/install.ps1 | iex"'
          : 'Install Bun: curl -fsSL https://bun.sh/install | bash',
        'Or with npm: npm install -g bun',
        'Then run the command again. More: https://bun.sh/docs/installation',
      ],
    },
  );
}

export function requireBunServer(): void {
  if (typeof Bun === 'undefined') throw bunServerError();
}

/** Under Node, run this command again with Bun and exit with its status. */
export async function rerunUnderBun(): Promise<void> {
  if (typeof Bun !== 'undefined') return;

  const commands = process.platform === 'win32' ? ['bun.exe', 'bun.cmd', 'bun'] : ['bun'];
  for (const command of commands) {
    const result = await rerunWith(command);
    if (result.error?.code === 'ENOENT' || result.error?.code === 'EINVAL') continue;
    if (result.error) throw result.error;
    if (result.signal) {
      const number = os.constants.signals[result.signal];
      process.exit(typeof number === 'number' ? 128 + number : 1);
    }
    process.exit(result.status ?? 1);
  }
  throw bunServerError();
}
