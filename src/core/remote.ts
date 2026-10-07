import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { loadAgents } from '../agent/load';
import { folderFiles } from '../agent/files';
import { INTEGRATIONS } from '../integrations';
import { CoderError } from './errors';
import { ServerClient, isLoopbackServer } from '../client';
import { renewal } from '../client/auth/renewal';
import {
  isKnownServer,
  rememberServer,
  savedSession,
  validateServer,
} from '../client/auth/session';
import type { ClientTypes } from '../client/types';
import type { AgentEvent } from '../agent/types';
import type { CredentialSummary } from '../server/settings/credentials';
import type { RunnerRow } from '../client/types';
import type { UsageTotals } from '../server/tasks/usage';
import type {
  AgentRecord,
  AgentDetail,
  AgentVersionRecord,
  ServerAgent,
  TaskStatus,
  UsageRecord,
} from '../server/store/types';
import type { PushResult } from '../server/store/types';
import {type LoginView} from '../server/settings/logins';

type RemoteTypes = Omit<
  ClientTypes,
  | 'agent'
  | 'detail'
  | 'version'
  | 'record'
  | 'task'
  | 'credential'
  | 'login'
  | 'runner'
  | 'usage'
  | 'event'
  | 'usageRow'
> & {
  agent: ServerAgent;
  detail: AgentDetail;
  version: AgentVersionRecord;
  record: AgentRecord;
  task: TaskStatus;
  credential: CredentialSummary;
  login: LoginView;
  runner: RunnerRow;
  usage: UsageTotals;
  event: AgentEvent;
  usageRow: UsageRecord;
};
export type RemoteClient = ServerClient<RemoteTypes>;

export interface ServerOptions {
  /** `true` for the default server (CODER_SERVER, else hosted); a URL for another. */
  server?: string | true;
  token?: string;
  yes?: boolean;
  /** Organization slug for this call; overrides the saved choice. */
  organization?: string;
}

/** The server `options` name; one not used before needs `yes`, then is remembered. */
export function serverFor(options: ServerOptions = {}): string {
  const target = validateServer(options.server);
  if (!isKnownServer(target)) {
    if (!options.yes)
      throw new CoderError(
        'invalid-option',
        `First use of Coder server ${new URL(target).origin} needs confirmation.`,
        { hint: 'Inspect the origin, then pass yes: true.' },
      );
    rememberServer(target);
  }
  return target;
}

/** A client for the server `options` name. */
export function connect(options: ServerOptions = {}): RemoteClient {
  const target = serverFor(options);
  return coderClient(target, {
    token: options.token,
    missingHint: `auth.login({ server: '${target}' })`,
    organization: options.organization,
  });
}

/** The single credential-selection and admin-token boundary for server clients. */
export function coderClient(
  server: string,
  {
    token,
    missingHint,
    organization,
  }: { token?: string; missingHint?: string; organization?: string } = {},
): RemoteClient {
  const target = validateServer(server);
  const saved = savedSession(target);
  const login = saved?.token;
  const admin = process.env.ADMIN_TOKEN;
  const bearer = token ?? login ?? admin;
  if (bearer && bearer === admin && !isLoopbackServer(target))
    throw new CoderError('invalid-option', 'ADMIN_TOKEN cannot be sent to a non-loopback server.');
  if (!bearer)
    throw new CoderError('login-failed', `Not signed in to ${target}.`, {
      ...(missingHint ? { hint: missingHint } : {}),
    });
  return new ServerClient<RemoteTypes>(
    target,
    { token: bearer },
    {
      organization: organization ?? saved?.organization?.slug,
      renewal: saved && bearer === login ? renewal(target, saved) : undefined,
    },
  );
}

export async function pushAgents(
  api: RemoteClient,
  cwd: string,
  id?: string,
): Promise<PushResult[]> {
  const local = (await loadAgents(cwd, INTEGRATIONS)).filter(agent => !agent.builtin);
  const selected = id ? local.filter(agent => agent.id === id) : local;
  if (id && !selected.length)
    throw new CoderError('invalid-option', `No workspace agent named "${id}".`);
  const results: PushResult[] = [];
  for (const agent of selected)
    results.push(
      await api.agents.put(agent.id, {
        definition: agent.definition,
        systemPrompt: await fs.readFile(path.join(agent.dir!, 'system.md'), 'utf8').catch(() => ''),
        files: await folderFiles(agent.dir!),
        name: agent.name,
        description: agent.definition.description,
      }),
    );
  return results;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ENGINES = ['claude', 'codex', 'custom'] as const;

const invalid = (message: string, hint?: string) =>
  new CoderError('invalid-option', message, hint ? { hint } : {});

const pause = () => new Promise(resolve => setTimeout(resolve, 1000));

async function stdinValue(): Promise<string> {
  let value = '';
  for await (const chunk of process.stdin) value += chunk.toString();
  return value.replace(/\r?\n$/, '');
}

export interface CredentialAddOptions extends ServerOptions {
  engine?: string;
  /** The values by name, or names whose values come from `value` (`-` reads stdin), else this environment. */
  env: Record<string, string> | string[];
  value?: string;
  workspace?: boolean;
  noCheck?: boolean;
  default?: boolean;
}

/** Add an API key or other engine environment values as a personal or workspace credential. */
export async function addCredential(
  label: string | undefined,
  options: CredentialAddOptions,
): Promise<{ ok: true; label: string }> {
  const names = Array.isArray(options.env) ? options.env : Object.keys(options.env);
  for (const name of names)
    if (!ENV_NAME.test(name))
      throw invalid(`Invalid environment variable name ${JSON.stringify(name)}.`);
  if (!options.engine) throw invalid('Missing required --engine.', 'Use claude, codex, or custom');
  const engine = ENGINES.find(value => value === options.engine);
  if (!engine) throw invalid('Invalid --engine value.', 'Use claude, codex, or custom');
  if (!names.length) throw invalid('At least one --env NAME is required.');
  if (options.value !== undefined && names.length !== 1)
    throw invalid('--value requires exactly one --env NAME.');

  const env = Array.isArray(options.env)
    ? Object.fromEntries(
        await Promise.all(
          names.map(async name => {
            const value =
              options.value === '-' ? await stdinValue() : (options.value ?? process.env[name]);
            if (!value) throw invalid(`Environment variable ${name} is not set.`);
            return [name, value] as const;
          }),
        ),
      )
    : options.env;

  return connect(options).credentials.add({
    ...(label ? { label } : {}),
    env,
    engine,
    workspace: options.workspace,
    noCheck: options.noCheck,
    default: options.default,
  });
}

export interface CredentialLoginOptions extends ServerOptions {
  /** Gets a cancel for the started sign-in. */
  onStart?(cancel: () => Promise<unknown>): void;
  /** Shows the sign-in link and code once the runner has them. */
  onOpen?(login: LoginView): void;
  /** Asks for the code Claude's sign-in page shows. */
  code?(): Promise<string>;
}

/** Sign in to a Claude or Codex subscription through the server's runner; resolves once it is done or failed. */
export async function loginCredential(
  engine: string | undefined,
  options: CredentialLoginOptions = {},
): Promise<LoginView> {
  if (engine !== 'claude' && engine !== 'codex')
    throw invalid(
      'Name the engine to sign in to.',
      'Usage: coder credentials login <claude|codex>',
    );

  const api = connect(options).credentials;
  let login = await api.login(engine);
  options.onStart?.(() => api.cancelLogin(login.id));
  const settle = async (done: (state: LoginView['state']) => boolean) => {
    while (!done(login.state)) {
      await pause();
      login = await api.loginStatus(login.id);
    }
  };

  await settle(state => state !== 'starting');
  options.onOpen?.(login);
  if (engine === 'claude' && login.state === 'open' && options.code)
    await api.loginCode(login.id, await options.code());
  await settle(state => state === 'done' || state === 'failed');
  return login;
}
