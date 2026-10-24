/** Runs one server task on this machine: fetch it, check out its repository, run the agent, report back. */
import { execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

import { processTiming } from '../utils/process';

import {
  AGENT_TASK_PREFIX,
  execAgent,
  threadReply,
  postReply,
  postTurnReply,
  waitForAgentTask,
} from '../agent/exec';
import { INTEGRATIONS } from '../integrations';
import { nativeToolEnvironment, tokenEnvName, type ReplyEndpoint } from '../agent/mcp';
import type { AgentTask, ModelAttempt } from '../agent/types';
import { effectiveSettings } from '../agent/definition';
import type { EngineCredential } from '../server/store/types';
import {
  loadConfig,
  MACHINE_SANDBOX_ENV,
  splitEngineSpec,
  WORKSPACE_CONFIG_ENV,
  type Access,
  type CoderConfig,
} from '../core/config';
import {
  loadTask,
  listTasks,
  resolveTaskDir,
  coderCache,
  enqueueSteer,
  withTaskAdmission,
  readTurnResults,
  hasQueuedSteers,
  claimSteers,
  isPidAlive,
  appendTaskLog,
  watchTask,
} from '../core/state';
import { listApprovals } from '../core/approvals';
import {
  answerTaskApproval,
  askTask,
  heldConnections,
  steerTask,
  stopTask,
  type ConnectionResolver,
} from '../core/task/actions';
import { addTokens, SKIPPED } from '../core/task/view';
import { readResultJson, resolveMcpServers, resolveTaskOptions, waitTask } from '../core/dispatch';
import { connectionEnvironment, connectionVariables } from '../core/connections';
import type { InboxEntry, InboxAck } from '../server/tasks/queue';
import { nodeListener } from '../server/routes/http';
import { askWorker, serveMailbox, mailboxId, type MailboxKey } from '../core/mailbox';
import type { Task, McpServerSpec, ResolvedTaskOptions } from '../core/types';
import type { FlowHooks } from '../flow/runtime';
import { asyncTools } from '../core/task/context/tools';
import { reviewLinks } from '../flow/builtin/review/post';
import {
  readJsonFile,
  writeJsonFileAtomic,
  createJsonlTail,
  watchChanges,
  withFileLock,
} from '../utils/fsx';
import { CLAUDE_PROJECT, taskHistory } from './history';
import { claimCalls, driveAsyncTool, pendingCall } from '../core/task/async';

const exec = promisify(execFile);

type RemoteTask = {
  task: AgentTask;
  generation: number;
  logCursor?: number;
  timeoutMs?: number;
  tokens: Record<string, string>;
  checksToken?: string;
  dashboard?: string;
  reviewAssets?: string;
  gitAuthor?: { name: string; email: string };
  postToken?: string;
  credential: EngineCredential;
  engineCredentials?: Array<{ id: string; credential: EngineCredential }>;
  config?: Partial<CoderConfig>;
  connections?: Record<string, McpServerSpec>;
  connectionEnv?: Record<string, string>;
};

/** The server and attempt token a runner process was started with. */
export function taskServer(): { server: string; token: string } {
  const server = process.env.CODER_SERVER?.replace(/\/+$/, '');
  const token = process.env.CODER_TASK_TOKEN;
  if (!server || !token)
    throw new Error('CODER_SERVER and CODER_TASK_TOKEN are required with --task');
  return { server, token };
}

async function taskRequest<T>(
  server: string,
  token: string,
  id: string,
  suffix = '',
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${server}/tasks/${encodeURIComponent(id)}${suffix}`, {
    ...init,
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(
      new Error((body as { error?: string }).error ?? `Coder server answered ${response.status}`),
      { status: response.status },
    );
  return body as T;
}

function validRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    !ref.startsWith('-') &&
    !ref.endsWith('/') &&
    !ref.endsWith('.') &&
    !ref.endsWith('.lock') &&
    !/[\x00-\x20\x7f~^:?*[\\]/.test(ref) &&
    !ref.includes('..') &&
    !ref.includes('@{') &&
    !ref.includes('//')
  );
}

export async function checkout(
  task: AgentTask,
  root: string,
  token?: string,
  cache?: string,
  signal?: AbortSignal,
): Promise<string> {
  const repo = task.event?.repo;
  const cwd = path.join(root, 'work');
  if (!repo) {
    await fs.mkdir(cwd, { recursive: true });
    return cwd;
  }
  // A later turn keeps the checkout as the earlier turns left it; a snapshot's clone still moves to the default branch.
  const present = (file: string) => fs.stat(file).then(Boolean, () => false);
  if (
    (await present(path.join(cwd, '.git'))) &&
    (cache || (await present(path.join(root, '.runner-task.json'))))
  )
    return cwd;
  if (!validRef(repo.defaultBranch)) throw new Error('Invalid repository ref');
  const clone = new URL(repo.cloneUrl);
  const hosts = INTEGRATIONS[task.event!.integration]?.repos?.cloneHosts ?? [];
  if (clone.protocol !== 'https:' || !hosts.includes(clone.hostname))
    throw new Error('Repository clone host does not match the integration');
  await fs.mkdir(root, { recursive: true });
  const credentialDir = await fs.mkdtemp(path.join(root, '.git-credential-'));
  const tokenFile = path.join(credentialDir, 'token');
  const askpass = path.join(credentialDir, 'askpass.sh');
  if (token) {
    await fs.writeFile(tokenFile, token, { mode: 0o600 });
    await fs.writeFile(
      askpass,
      '#!/bin/sh\ncase "$1" in *Username*) printf x-access-token;; *) command cat "$CODER_GIT_TOKEN_FILE";; esac\n',
      { mode: 0o700 },
    );
  }
  const options = token
    ? {
        env: {
          ...process.env,
          GIT_ASKPASS: askpass,
          CODER_GIT_TOKEN_FILE: tokenFile,
          GIT_TERMINAL_PROMPT: '0',
        },
      }
    : undefined;
  try {
    const gitOptions = { ...options, signal, maxBuffer: 64 * 1024 * 1024 };
    if (cache) {
      await withCheckoutLock(cache, async () => {
        if (!(await fs.stat(path.join(cache, '.git')).catch(() => undefined))) {
          const staging = await fs.mkdtemp(`${cache}-clone-`);
          try {
            await exec('git', ['clone', '--depth', '50', repo.cloneUrl, staging], gitOptions);
            await fs.rename(staging, cache);
          } finally {
            await fs.rm(staging, { recursive: true, force: true });
          }
        }
        await exec('git', ['-C', cache, 'worktree', 'prune', '--expire', 'now'], gitOptions);
        await exec('git', ['-C', cache, 'remote', 'set-url', 'origin', repo.cloneUrl], gitOptions);
        await exec(
          'git',
          ['-C', cache, 'fetch', '--depth', '50', 'origin', repo.defaultBranch],
          gitOptions,
        );
        await exec(
          'git',
          ['-C', cache, 'worktree', 'add', '--detach', cwd, 'FETCH_HEAD'],
          gitOptions,
        );
      });
    } else {
      // A sandbox snapshot already holds the clone.
      if (!(await present(path.join(cwd, '.git'))))
        await exec('git', ['clone', '--depth', '50', repo.cloneUrl, cwd], gitOptions);
      await exec(
        'git',
        ['-C', cwd, 'fetch', '--depth', '50', 'origin', repo.defaultBranch],
        gitOptions,
      );
      await exec('git', ['-C', cwd, 'checkout', '--detach', 'FETCH_HEAD'], gitOptions);
    }
    await fs.writeFile(
      baseFile(root),
      (await exec('git', ['-C', cwd, 'rev-parse', 'HEAD'])).stdout,
    );
  } finally {
    await fs.rm(credentialDir, { recursive: true, force: true });
  }
  return cwd;
}

/** Cache location shared by local runner processes. */
export function checkoutCache(task: AgentTask): string | undefined {
  const repo = task.event?.repo;
  if (!repo) return;
  if (![repo.owner, repo.name].every(part => /^[\w.-]+$/.test(part) && !/^\.+$/.test(part)))
    throw new Error('Invalid repository name');
  return coderCache('checkouts', new URL(repo.cloneUrl).hostname, repo.owner, repo.name);
}

export async function withCheckoutLock<T>(cache: string, work: () => Promise<T>): Promise<T> {
  return withFileLock(`${cache}.lock`, work, Infinity, 5 * 60_000);
}

/** Remove a linked task worktree, including task edits. Ordinary clones stay intact. */
export async function releaseCheckout(cwd: string): Promise<void> {
  if (!(await fs.stat(path.join(cwd, '.git')).catch(() => undefined))?.isFile()) return;
  const result = await exec('git', ['-C', cwd, 'rev-parse', '--git-common-dir']).catch(
    async error => {
      if (await fs.stat(path.join(cwd, '.git')).catch(() => undefined)) throw error;
      return undefined;
    },
  );
  if (!result) return;
  const { stdout } = result;
  const common = path.resolve(cwd, stdout.trim());
  const cache = path.dirname(common);
  await withCheckoutLock(cache, async () => {
    if (await fs.stat(path.join(cwd, '.git')).catch(() => undefined))
      await exec('git', ['--git-dir', common, 'worktree', 'remove', '--force', cwd]);
  });
}

const MAX_DIFF_BYTES = 1024 * 1024;

/** The commit the task's checkout started on, so commits made in it still show in its diff. */
const baseFile = (root: string) => path.join(root, '.checkout-base');

/** What the task changed in its checkout since it started, new files and commits included. */
async function changes(cwd: string, root: string): Promise<string> {
  const options = { maxBuffer: 64 * 1024 * 1024 };
  const base = (await fs.readFile(baseFile(root), 'utf8').catch(() => 'HEAD')).trim();
  await exec('git', ['-C', cwd, 'add', '--intent-to-add', '--all'], options);
  const { stdout } = await exec('git', ['-C', cwd, 'diff', base], options);
  return Buffer.byteLength(stdout) > MAX_DIFF_BYTES
    ? `${Buffer.from(stdout).subarray(0, MAX_DIFF_BYTES).toString()}\n[diff truncated]`
    : stdout;
}

/** Returns the task's own `CODEX_HOME` when the credential is a Codex sign-in. The engine reaches the task's server through `socketPath`. */
async function applyEnvironment(
  remote: RemoteTask,
  root: string,
  socketPath: string,
): Promise<string | undefined> {
  process.env.CODER_SERVER = `unix:${socketPath}`;
  if (remote.dashboard) process.env.CODER_DASHBOARD = remote.dashboard;
  delete process.env.CODER_TASK_TOKEN;
  delete process.env.APP_TOKEN;
  for (const id of Object.keys(remote.tokens)) delete process.env[tokenEnvName(id)];
  for (const row of remote.engineCredentials ?? [])
    for (const name of Object.keys(row.credential.env)) delete process.env[name];
  const { CODEX_AUTH_JSON: authJson, [MACHINE_SANDBOX_ENV]: _, ...env } = remote.credential.env;
  Object.assign(process.env, env);
  process.env[WORKSPACE_CONFIG_ENV] = JSON.stringify(remote.config ?? {});
  if (remote.gitAuthor) {
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = remote.gitAuthor.name;
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = remote.gitAuthor.email;
  }
  process.env.CODER_MCP_MODE = 'cloud';
  process.env.CODER_MCP_CONNECTION_ENV = JSON.stringify(
    connectionVariables(remote.connections ?? {}),
  );
  if (!authJson) return undefined;
  const home = await fs.mkdtemp(path.join(root, '.codex-'));
  await fs.writeFile(path.join(home, 'auth.json'), authJson, { mode: 0o600 });
  process.env.CODEX_HOME = home;
  return home;
}

/** A Claude credential gets its own config folder, so transcripts land where the runner saves them from. */
async function applyClaudeHome(remote: RemoteTask, root: string): Promise<string | undefined> {
  const { ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN } = remote.credential.env;
  if (remote.credential.engine !== 'claude' || (!ANTHROPIC_API_KEY && !CLAUDE_CODE_OAUTH_TOKEN))
    return undefined;
  const home = await fs.mkdtemp(path.join(root, '.claude-'));
  process.env.CLAUDE_CONFIG_DIR = home;
  process.env.CLAUDE_CODE_PROJECT_DIR_NAME = CLAUDE_PROJECT;
  return home;
}

/** Every secret value the runner was given, stripped from engine history before it leaves. */
async function historySecrets(
  remote: RemoteTask,
  token: string,
  codexHome: string | undefined,
): Promise<string[]> {
  const rotated = codexHome
    ? await fs.readFile(path.join(codexHome, 'auth.json'), 'utf8').catch(() => '')
    : '';
  const tokens = (authJson = '') => {
    const found: string[] = [];
    try {
      JSON.parse(authJson, (key, value) => {
        if (typeof value === 'string' && /token|key/i.test(key)) found.push(value);
        return value;
      });
    } catch (error) {
      if (authJson) console.error('coder runner: history credentials could not be parsed');
    }
    return found;
  };

  return [
    token,
    ...Object.values(remote.tokens),
    ...(remote.checksToken ? [remote.checksToken] : []),
    ...(remote.postToken ? [remote.postToken] : []),
    ...Object.values(remote.connectionEnv ?? {}),
    ...Object.entries(remote.credential.env)
      .filter(([name]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(name))
      .map(([, value]) => value),
    ...tokens(remote.credential.env.CODEX_AUTH_JSON),
    ...(remote.engineCredentials?.flatMap(row => [
      ...Object.values(row.credential.env),
      ...tokens(row.credential.env.CODEX_AUTH_JSON),
    ]) ?? []),
    ...tokens(rotated),
  ];
}

/** Codex rotates its tokens; hand the new `auth.json` back so the next task starts from it. */
async function writeBack(
  auth: { server: string; token: string },
  id: string,
  credential: { id?: string; authJson?: string },
  home: string | undefined,
): Promise<void> {
  if (!home) return;
  const authJson = await fs.readFile(path.join(home, 'auth.json'), 'utf8').catch(() => '');
  if (authJson && credential.id && authJson !== credential.authJson)
    await taskRequest(auth.server, auth.token, id, '/credential', {
      method: 'POST',
      body: JSON.stringify({ authJson, credentialId: credential.id }),
    }).catch(() => {});
  await fs.rm(home, { recursive: true, force: true });
}

/** The credentials a flow step or review runs a model on, best first, as environments over the runner's: each sets its own variables and unsets the task's others; a Codex sign-in other than the turn's gets its own home, handed back by `release`. */
function stepCredentials(
  remote: RemoteTask,
  root: string,
  machineHomes: Record<string, string | undefined>,
  current: () => string | undefined,
) {
  const homes = new Map<string, { home: string; authJson: string }>();
  const credentials = async (option: ResolvedTaskOptions): Promise<NodeJS.ProcessEnv[]> => {
    const rows = remote.engineCredentials ?? [];
    const key =
      option.engine === 'custom'
        ? (loadConfig(root).models?.[option.model ?? ''] as { envKey?: string } | undefined)
            ?.envKey ?? 'OPENAI_API_KEY'
        : undefined;
    const serving = rows.filter(row =>
      key ? row.credential.env[key] !== undefined : row.credential.engine === option.engine,
    );
    // A machine run, its attempts without a credential, uses the machine's own sign-ins.
    const machine = remote.task.runner === 'http' || remote.task.models?.some(attempt => !attempt.credential);
    if (!serving.length) return machine ? [{}] : [];
    const unset = Object.fromEntries(
      rows.flatMap(row => Object.keys(row.credential.env)).map(name => [name, undefined]),
    );

    return Promise.all(
      serving.map(async row => {
        const { CODEX_AUTH_JSON: authJson, ...env } = row.credential.env;
        const own = row.id === current();
        let home = authJson && own ? process.env.CODEX_HOME : machineHomes.CODEX_HOME;
        if (authJson && !own) {
          if (!homes.has(row.id)) {
            const created = await fs.mkdtemp(path.join(root, '.codex-'));
            await fs.writeFile(path.join(created, 'auth.json'), authJson, { mode: 0o600 });
            homes.set(row.id, { home: created, authJson });
          }
          home = homes.get(row.id)!.home;
        }

        return {
          ...unset,
          ...env,
          CODEX_HOME: home,
          CLAUDE_CONFIG_DIR: own ? process.env.CLAUDE_CONFIG_DIR : machineHomes.CLAUDE_CONFIG_DIR,
        };
      }),
    );
  };
  const release = async (auth: { server: string; token: string }, id: string) => {
    await Promise.all(
      [...homes].map(([credential, { home, authJson }]) =>
        writeBack(auth, id, { id: credential, authJson }, home),
      ),
    );
    homes.clear();
  };

  return { credentials, release };
}

const INSTALLS: Array<[string, string, string[]]> = [
  ['bun.lock', 'bun', ['install', '--frozen-lockfile']],
  ['bun.lockb', 'bun', ['install', '--frozen-lockfile']],
  ['pnpm-lock.yaml', 'npx', ['-y', 'pnpm', 'install', '--frozen-lockfile']],
  ['yarn.lock', 'npx', ['-y', 'yarn', 'install', '--frozen-lockfile']],
  ['package-lock.json', 'npm', ['ci']],
];

/** Clone a task's repository at its default branch and install dependencies, for a sandbox snapshot. */
export async function prepareRepo(id: string, root: string): Promise<{ sha: string }> {
  const auth = taskServer();
  const remote = await taskRequest<RemoteTask>(auth.server, auth.token, id);
  const event = remote.task.event;
  if (!event?.repo) throw new Error('The task has no repository');
  const cwd = await checkout(remote.task, root, remote.tokens[event.integration]);
  for (const [lock, command, args] of INSTALLS) {
    if (!(await fs.stat(path.join(cwd, lock)).catch(() => undefined))) continue;
    await exec(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 }).catch(() => {});
    break;
  }
  const sha = (await exec('git', ['-C', cwd, 'rev-parse', 'HEAD'])).stdout.trim();
  console.log(`coder-snapshot ${sha}`);
  return { sha };
}

export function startInboxControl(
  root: string,
  task: string,
  apply: (entry: InboxEntry) => Promise<unknown>,
) {
  const pending = new Set<Promise<unknown>>();
  const stop = serveMailbox(path.join(root, 'inbox-control'), {
    apply(payload: { task: string; entry: InboxEntry }) {
      const entry = payload.entry;
      if (
        payload.task !== task ||
        !Number.isInteger(entry?.seq) ||
        entry.seq < 0 ||
        !Number.isInteger(entry.generation) ||
        entry.generation < 0 ||
        !['steer', 'ask', 'approve'].includes(entry.kind)
      )
        throw new Error('Invalid engine inbox command');
      const work = apply(entry);
      pending.add(work);
      void work.finally(() => pending.delete(work)).catch(() => {});
      return work;
    },
  });
  return {
    close: async () => {
      stop();
      await Promise.allSettled([...pending]);
    },
  };
}

export function requestInboxControl(
  root: string,
  task: string,
  entry: InboxEntry,
): Promise<unknown> {
  const id = mailboxId({ task, generation: entry.generation, seq: entry.seq });
  return askWorker(
    'apply',
    { task, entry },
    { dir: path.join(root, 'inbox-control'), id, keepReply: true, timeoutMs: 30_000 },
  );
}

/** A live run's next turn: the connections the task's server resolves for it now, its grants and the asker's personal ones, as a fresh run gets them. */
export function serverConnections(endpoint: ReplyEndpoint): ConnectionResolver {
  return async () => {
    const response = await fetch(endpoint.url, {
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Coder server answered ${response.status}`);
    const remote = (await response.json()) as RemoteTask;
    const connected = connectionEnvironment(remote.connections ?? {}, remote.connectionEnv);
    const native = nativeToolEnvironment(remote.task, remote.tokens, {
      ...endpoint,
      ...(remote.dashboard ? { dashboard: remote.dashboard } : {}),
    });

    return { mcp: connected.mcp, env: { ...connected.env, ...native.env }, warnings: [] };
  };
}

/** A runner task's next turn asks its server through the conversation endpoint; without one it keeps what its task resolved. */
export function liveConnections(task: Task): ConnectionResolver {
  return async granted => {
    const reply = resolveMcpServers(task.mcp, process.env).find(
      server => server.name === 'conversation',
    )?.env;

    return (
      reply?.CODER_REPLY_URL && reply.CODER_REPLY_TOKEN
        ? serverConnections({ url: reply.CODER_REPLY_URL, token: reply.CODER_REPLY_TOKEN })
        : heldConnections(task.mcp)
    )(granted);
  };
}

/** A steer's model and access, as its sender gave them. */
function turnOverrides(value: Record<string, unknown> | undefined): { model?: string; access?: Access } {
  return {
    ...(typeof value?.model === 'string' && value.model ? { model: value.model } : {}),
    ...(value?.access === 'read-only' || value?.access === 'auto' ? { access: value.access } : {}),
  };
}

export async function applyTaskMessage(
  cwd: string,
  task: Task,
  entry: InboxEntry,
  resolveConnections: ConnectionResolver = liveConnections(task),
): Promise<unknown> {
  const command: MailboxKey = {
    task: task.name?.slice(6) ?? task.id,
    generation: entry.generation,
    seq: entry.seq,
  };
  const transcript = path.join(
    resolveTaskDir(cwd, task.id),
    'inbox-control',
    `${mailboxId(command)}.transcript.jsonl`,
  );
  return withFileLock(`${transcript}.lock`, async () => {
    const lines = await fs.readFile(transcript, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    for (const line of lines.split('\n')) {
      if (!line.trim()) continue;
      let recorded: { command: MailboxKey; result: unknown };
      try {
        recorded = JSON.parse(line);
      } catch {
        continue;
      }
      if (mailboxId(recorded.command) === mailboxId(command) && Object.hasOwn(recorded, 'result'))
        return recorded.result;
    }
    const value = entry.value as Record<string, unknown> | undefined;
    if (entry.kind === 'steer') {
      const text = String(value?.text ?? entry.value ?? '');
      let queued = false;
      if (!task.threadId) {
        queued = await withTaskAdmission(cwd, task.id, () => {
          const current = loadTask(cwd, task.id) ?? task;
          if (current.threadId) return false;
          if (current.steerClosed || !['running', 'queued'].includes(current.status))
            throw new Error('Task stopped before it opened a conversation');
          enqueueSteer(cwd, task.id, text);
          return true;
        });
      }
      if (!queued)
        await steerTask(cwd, loadTask(cwd, task.id) ?? task, text, {
          command,
          resolveConnections,
          ...turnOverrides(value),
        });
    } else if (entry.kind === 'ask') {
      const result = await askTask(cwd, task, String(value?.question ?? entry.value ?? ''), {
        command,
        ...(typeof value?.model === 'string' && value.model ? { model: value.model } : {}),
      });
      return result.finalMessage ?? result.error?.message ?? '';
    } else if (entry.kind === 'approve') {
      const approvalId = String(value?.approvalId ?? value?.id ?? '');
      try {
        await answerTaskApproval(
          cwd,
          task,
          approvalId,
          value?.decision === 'deny' || value?.decision === 'decline' ? 'decline' : 'accept',
          {
            ...(typeof value?.reason === 'string' ? { reason: value.reason } : {}),
            command,
            resolveConnections,
          },
        );
      } catch (error) {
        // An answer the record refuses (approved, then a late deny) is consumed, so the inbox moves on.
        if (!(error instanceof Error && error.message.includes('already approved'))) throw error;
        appendTaskLog(cwd, task.id, {
          kind: 'status',
          message: `Ignored an answer to approval ${approvalId}: ${error.message}`,
        });
      }
    }
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    await fs.appendFile(transcript, JSON.stringify({ command, result: null }) + '\n');
  });
}

/** A request a task cannot do without, its start and its result: a dropped connection or 5xx gets paced tries. */
async function landing<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      const status = (error as { status?: number }).status;
      if ((status !== undefined && status < 500) || attempt >= 6) throw error;
      console.error(
        `coder runner: Coder server did not take the request, trying again: ${error instanceof Error ? error.message : error}`,
      );
      await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
    }
  }
}

export async function runTask(id: string, root: string): Promise<unknown> {
  const auth = taskServer();
  processTiming('runner.credentials.start');
  const remote = await landing(() => taskRequest<RemoteTask>(auth.server, auth.token, id)).catch(
    async error => {
      await taskRequest(auth.server, auth.token, id, '/result', {
        method: 'POST',
        body: JSON.stringify({
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        }),
      }).catch(() => {});
      throw error;
    },
  );
  processTiming('runner.credentials.done');
  const event = remote.task.event;
  const eventToken = event && remote.tokens[event.integration];
  const polling = process.env.CODER_INBOX_MODE === 'poll';
  delete process.env.CODER_INBOX_MODE;
  const cache = process.env.CODER_CHECKOUT_CACHE;
  delete process.env.CODER_CHECKOUT_CACHE;
  let codexHome: string | undefined;
  let claudeHome: string | undefined;
  const machineHomes = {
    CODEX_HOME: process.env.CODEX_HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  };
  let history: ReturnType<typeof taskHistory> | undefined;
  let proxy: Awaited<ReturnType<typeof serveTaskServer>> | undefined;
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new Error('timeout')),
    remote.timeoutMs ?? 30 * 60 * 1000,
  );
  const heartbeat = setInterval(() => {
    void taskRequest(auth.server, auth.token, id, '/heartbeat', {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }, 30_000);
  let cwd: string | undefined;
  const beforeResult = async () => {
    const started = readJsonFile<{ generation: number; id: string }>(
      path.join(root, '.runner-task.json'),
    );
    const current =
      cwd && started?.generation === remote.generation ? loadTask(cwd, started.id) : undefined;
    await history
      ?.save(current ?? undefined)
      .catch(error => console.error('coder runner: history upload failed', error));
    if (claudeHome) await fs.rm(claudeHome, { recursive: true, force: true });
    await writeBack(
      auth,
      id,
      { id: credentialId, authJson: remote.credential.env.CODEX_AUTH_JSON },
      codexHome,
    );
  };
  let credentialId = remote.task.models?.[0]?.credential;
  const steps = stepCredentials(remote, root, machineHomes, () => credentialId);
  let reportingResult = false;
  const reportResult = async (body: unknown) => {
    reportingResult = true;
    await beforeResult();
    await steps.release(auth, id);
    await landing(() =>
      taskRequest(auth.server, auth.token, id, '/result', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  };
  try {
    const setup = (async () => {
      proxy = await serveTaskServer(auth);
      [codexHome, claudeHome] = await Promise.all([
        applyEnvironment(remote, root, proxy.socketPath),
        applyClaudeHome(remote, root),
      ]);
      history =
        remote.task.flow === 'default'
          ? taskHistory(
              (suffix, init) => taskRequest(auth.server, auth.token, id, suffix, init),
              () => historySecrets(remote, auth.token, codexHome),
            )
          : undefined;
      processTiming('runner.environment.done');
      const restored = await history?.restore();
      processTiming('runner.history.done');
      return restored;
    })();
    processTiming('runner.checkout.start');
    const prepared = Promise.race([
      checkout(remote.task, root, eventToken, cache, timeout.signal),
      new Promise<never>((_, reject) =>
        timeout.signal.addEventListener('abort', () => reject(timeout.signal.reason), {
          once: true,
        }),
      ),
    ]).then(value => {
      cwd = value;
      processTiming('runner.checkout.done');
      return value;
    });
    const [repository, restored] = await Promise.allSettled([prepared, setup]);
    if (repository.status === 'rejected') throw repository.reason;
    if (restored.status === 'rejected') throw restored.reason;
    timeout.signal.throwIfAborted();
    return await runCheckedOutTask(
      id,
      root,
      auth,
      remote,
      repository.value,
      eventToken,
      polling,
      timeout.signal,
      beforeResult,
      reportResult,
      restored.value,
      async attempt => {
        if (attempt.credential === credentialId) return true;
        const selected = remote.engineCredentials?.find(row => row.id === attempt.credential);
        if (attempt.credential && !selected) return false;
        await beforeResult();
        for (const [name, value] of Object.entries(machineHomes)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        remote.credential = selected?.credential ?? {
          engine: splitEngineSpec(attempt.model).engine as EngineCredential['engine'],
          env: {},
        };
        credentialId = attempt.credential;
        [codexHome, claudeHome] = await Promise.all([
          applyEnvironment(remote, root, proxy!.socketPath),
          applyClaudeHome(remote, root),
        ]);
        return true;
      },
      steps.credentials,
    );
  } catch (error) {
    if (!reportingResult)
      await reportResult({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        ...(remote.task.event && INTEGRATIONS[remote.task.event.integration]?.isUninstalled?.(error)
          ? { installationRevoked: true }
          : {}),
      }).catch(failure => console.error('coder runner: result delivery failed', failure));
    throw error;
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    await proxy?.close();
    delete process.env[WORKSPACE_CONFIG_ENV];
    delete process.env.CODER_MCP_MODE;
    delete process.env.CODER_MCP_CONNECTION_ENV;
    delete process.env.CODER_SERVER;
    delete process.env.CODER_DASHBOARD;
  }
}

async function runCheckedOutTask(
  id: string,
  root: string,
  auth: { server: string; token: string },
  remote: RemoteTask,
  cwd: string,
  eventToken: string | undefined,
  polling: boolean,
  timeout: AbortSignal,
  beforeResult: () => Promise<void>,
  reportResult: (body: unknown) => Promise<void>,
  resumed: Awaited<ReturnType<ReturnType<typeof taskHistory>['restore']>> | undefined,
  onModel: (attempt: ModelAttempt) => Promise<boolean>,
  onFlowModel: FlowHooks['onModel'],
): Promise<unknown> {
  const event = remote.task.event;
  const postToken = remote.task.flow === 'default' ? remote.postToken : eventToken;
  const controller = new AbortController();
  let taskId: string | undefined;
  let flow: { runId: string; requestStop(): void; runningIds(): string[] } | undefined;
  let cancelled = false;
  const inbox = await receiveInbox({
    root,
    generation: remote.generation,
    apply: async entry => {
      const task = taskId && loadTask(cwd, taskId);
      if (!task) throw new Error('The task is not ready');
      if (entry.kind === 'cancel') {
        await stopTask(cwd, task);
        cancelled = true;
        await flushLogs();
        await beforeResult();
        return;
      }
      return requestInboxControl(resolveTaskDir(cwd, task.id), id, entry);
    },
  });
  let pendingAck: InboxAck | undefined = inbox.ack().seq >= 0 ? inbox.ack() : undefined;
  let acknowledging: Promise<void> | undefined;
  const ack = (): Promise<void> => {
    if (acknowledging) return acknowledging;
    if (!pendingAck) return Promise.resolve();
    const sent = pendingAck;
    acknowledging = taskRequest(auth.server, auth.token, id, '/ack', {
      method: 'POST',
      body: JSON.stringify(sent),
      signal: controller.signal,
    })
      .then(() => {
        if (pendingAck && pendingAck.seq <= sent.seq) pendingAck = undefined;
      })
      .catch(error => {
        if (error.status === 401 || error.status === 403) pendingAck = undefined;
        throw error;
      })
      .finally(() => {
        acknowledging = undefined;
      });
    return acknowledging;
  };
  const fetchMessages = async () => {
    const entries = await taskRequest<InboxEntry[]>(
      auth.server,
      auth.token,
      id,
      `/messages?after=${inbox.ack().seq}`,
      { signal: controller.signal },
    );
    try {
      if (entries.length) await inbox.apply(entries);
    } finally {
      if (entries.length && inbox.ack().seq >= 0) pendingAck = inbox.ack();
      await ack().catch(() => {});
    }
  };
  const ackTimer = setInterval(() => {
    void ack().catch(() => {});
  }, 1000);
  const savedTask = readJsonFile<{
    generation: number;
    id: string;
    turn: number;
    usageStart: number;
  }>(path.join(root, '.runner-task.json'));
  const logWatchers = new Map<string, ReturnType<typeof watchChanges>>();
  const logged = new Map<string, () => string[]>();
  let sequence = (remote.logCursor ?? -1) + 1;
  let logBytes = 0;
  const pending: Array<{ seq: number; at: number; level: 'out' | 'err'; line: string }> = [];
  let forwarding: Promise<void> | undefined;
  const forwardLogs = (): Promise<void> => {
    for (const tail of logged.values())
      for (const line of tail()) {
        if (logBytes >= 2 * 1024 * 1024) continue;
        const bounded =
          Buffer.byteLength(line) > 64 * 1024 ? 'A task log entry exceeded 64 KB' : line;
        pending.push({ seq: sequence++, at: Date.now(), level: 'out', line: bounded });
        logBytes += Buffer.byteLength(bounded);
      }
    if (forwarding) return forwarding;
    forwarding = (async () => {
      while (pending.length) {
        let size = 0;
        const entries = pending
          .slice(0, 100)
          .filter(entry => (size += Buffer.byteLength(JSON.stringify(entry))) < 512 * 1024);
        if (!entries.length) throw new Error('Task log batch is too large');
        let saved = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await taskRequest(auth.server, auth.token, id, '/logs', {
              method: 'POST',
              signal: AbortSignal.timeout(5000),
              body: JSON.stringify({ entries }),
            });
            saved = true;
            break;
          } catch (error) {
            if (attempt === 2) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
        if (saved) pending.splice(0, entries.length);
      }
    })().finally(() => {
      forwarding = undefined;
    });

    return forwarding;
  };
  const flushLogs = () =>
    forwardLogs().catch(error => {
      console.error('coder runner: log delivery failed', error);
    });
  let shortPoll: ReturnType<typeof setInterval> | undefined;
  let fetching: Promise<unknown> | undefined;
  let inboxClosed = false;
  const previousTurns = savedTask?.generation === remote.generation ? savedTask.usageStart : 0;
  const firstTurn = savedTask?.generation === remote.generation ? savedTask.turn : 0;
  let deliveredTurns = firstTurn + 1;
  const post = (text: string) =>
    postReply(INTEGRATIONS[event!.integration]!, event!, text, postToken!, remote.task.author);
  const approvals = () => (taskId ? listApprovals(resolveTaskDir(cwd, taskId)) : []);
  const onApproval = async (approval: unknown) => {
    await taskRequest(auth.server, auth.token, id, '/result', {
      method: 'POST',
      body: JSON.stringify({ status: 'waiting', approval, approvals: approvals() }),
    });
  };
  // A fallback shows on the task's page as it happens, and the model line follows what runs.
  let reported = 0;
  const reportAttempt = async (attempt: ModelAttempt) => {
    const fallbacks = (taskId && loadTask(cwd, taskId)?.fallbacks) || [];
    if (fallbacks.length <= reported) return;
    reported = fallbacks.length;
    await taskRequest(auth.server, auth.token, id, '/result', {
      method: 'POST',
      body: JSON.stringify({
        status: 'running',
        fallbacks,
        model: attempt.model,
        ...(attempt.credential ? { credential: attempt.credential } : {}),
      }),
    }).catch(error => console.error('coder runner: fallback report failed', error));
  };
  // The runner drives a task's review calls itself, so each model runs on its own credential.
  const driving = new Set<Promise<void>>();
  const driveCalls = (started: string) =>
    claimCalls(resolveTaskDir(cwd, started))
      .then(calls => {
        for (const call of calls) {
          const tool = asyncTools.find(candidate => candidate.name === call.tool);
          if (!tool) continue;
          const work = driveAsyncTool(tool, call.runId, cwd, started, call.timeout, {
            integrationToken: tool.platform ? remote.tokens[tool.platform] : undefined,
            checksToken: remote.checksToken,
            links: reviewLinks(
              auth.server,
              remote.dashboard,
              remote.task.taskUrl,
              remote.reviewAssets,
            ),
            onModel: onFlowModel,
            stop: timeout,
          })
            .catch(error => console.error(`coder runner: ${call.tool} ${call.runId} failed`, error))
            .finally(() => driving.delete(work));
          driving.add(work);
        }
      })
      .catch(error => console.error('coder runner: async calls could not be read', error));
  try {
    const first = remote.task.models?.[0]?.model;
    const restored =
      resumed?.restored &&
      resumed.resume?.engine ===
        (first
          ? splitEngineSpec(first).engine
          : resolveTaskOptions(effectiveSettings(remote.task), loadConfig(cwd)).engine);
    let worker: ChildProcess | undefined;
    const running = execAgent({
      cwd,
      ...(savedTask?.generation === remote.generation
        ? { resumeTaskId: savedTask.id, resumeTurn: firstTurn }
        : {}),
      ...(resumed?.resume ? { resume: resumed.resume } : {}),
      agent: remote.task.agent,
      flow: remote.task.flow,
      // A resumed conversation already holds the earlier messages.
      task: restored
        ? { ...remote.task, context: { ...remote.task.context, messages: undefined } }
        : remote.task,
      toolEnvironment: { tokens: remote.tokens },
      replyEndpoint: {
        url: `${auth.server}/tasks/${encodeURIComponent(id)}`,
        token: auth.token,
        ...(remote.dashboard ? { dashboard: remote.dashboard } : {}),
      },
      connections: remote.connections,
      connectionEnv: remote.connectionEnv,
      post: remote.task.source === event?.integration,
      ...(postToken ? { postToken } : {}),
      onStart(started) {
        flow = started;
      },
      onWorker(_id, child) {
        worker = child;
        child.once('error', () => {
          worker = undefined;
        });
      },
      async onTask(started, turn) {
        taskId = started;
        if (timeout.aborted) {
          const task = loadTask(cwd, started);
          if (task) await stopTask(cwd, task);
          throw timeout.reason;
        }
        if (!logged.has(started))
          logged.set(
            started,
            createJsonlTail(path.join(resolveTaskDir(cwd, started), 'log.jsonl')),
          );
        if (!logWatchers.has(started))
          logWatchers.set(
            started,
            watchChanges(resolveTaskDir(cwd, started), file => {
              if (!file || file === 'log.jsonl') void forwardLogs().catch(() => {});
              if (!file || file === 'async.json') void driveCalls(started);
            }),
          );
        void forwardLogs().catch(() => {});
        void driveCalls(started);
        writeJsonFileAtomic(path.join(root, '.runner-task.json'), {
          generation: remote.generation,
          id: started,
          turn: turn ?? firstTurn,
          usageStart: previousTurns,
        });
        await ack().catch(() => {});
        await fetchMessages().catch(() => {});
        clearInterval(shortPoll);
        if (polling)
          shortPoll = setInterval(() => {
            if (!fetching)
              fetching = fetchMessages()
                .catch(() => {})
                .finally(() => {
                  fetching = undefined;
                });
          }, 4000);
      },
      onApproval,
      async onModel(attempt) {
        await reportAttempt(attempt);
        return onModel(attempt);
      },
      onFlowModel,
    });
    const aborted = new Promise<never>((_, reject) => {
      const abort = () => reject(timeout.reason);
      timeout.addEventListener('abort', abort, { once: true });
      if (timeout.aborted) abort();
    });
    const result = await Promise.race([running, aborted]);
    deliveredTurns = (result.turn ?? firstTurn) + 1;
    if (taskId && remote.task.flow === 'default') {
      const postedMessages = [...(result.postedMessages ?? [])];
      const resultSignal = watchTask(cwd, taskId, worker);
      try {
        for (;;) {
          const turns = readTurnResults(cwd, taskId);
          for (const [offset, turn] of turns.slice(deliveredTurns).entries()) {
            const reply = threadReply(remote.task, turn, cancelled, turn);
            if (reply.skipped) appendTaskLog(cwd, taskId, { kind: 'status', message: SKIPPED });
            if (remote.task.source === event?.integration && reply.text && !reply.duplicate)
              postedMessages.push(
                ...(await postTurnReply(cwd, taskId, deliveredTurns + offset, () =>
                  post(reply.text),
                )),
              );
            result.reply = reply.text;
            result.ok = turn.status === 0;
            result.error = turn.error?.message;
          }
          deliveredTurns = Math.max(deliveredTurns, turns.length);
          const current = loadTask(cwd, taskId);
          if (current?.status === 'running' || current?.status === 'queued') {
            await Promise.race([
              waitForAgentTask(cwd, taskId, onApproval, (cwd, id, opts) =>
                waitTask(cwd, id, { ...opts, turn: deliveredTurns, worker, signal: timeout }),
              ),
              aborted,
            ]);
            continue;
          }
          // Follow-ups queued while a worker was finishing, with no worker left to run them, start their own turn.
          // A task that ended cancelled or failed keeps nothing: its queued follow-ups are dropped.
          if (current && !isPidAlive(current.pid) && hasQueuedSteers(cwd, taskId)) {
            if (current.status !== 'completed') {
              const dropped = claimSteers(cwd, taskId).length;
              appendTaskLog(cwd, taskId, {
                kind: 'status',
                message: `Discarded ${dropped} queued follow-up${dropped === 1 ? '' : 's'}: the task is ${current.status}.`,
              });
              continue;
            }
            const [first, ...rest] = claimSteers(cwd, taskId);
            for (const text of rest) enqueueSteer(cwd, taskId, text);
            if (first) {
              await steerTask(cwd, current, first, {
                resolveConnections: serverConnections({
                  url: `${auth.server}/tasks/${encodeURIComponent(id)}`,
                  token: auth.token,
                }),
                onWorker: child => {
                  worker = child;
                },
              });
              continue;
            }
          }
          if (
            (worker?.exitCode === null && !worker.signalCode) ||
            hasQueuedSteers(cwd, taskId) ||
            pendingCall(resolveTaskDir(cwd, taskId))
          ) {
            await Promise.race([resultSignal.wait(30000), aborted]);
            continue;
          }
          if (!inboxClosed) {
            clearInterval(shortPoll);
            await fetching;
            await inbox.close();
            inboxClosed = true;
            continue;
          }
          if (readTurnResults(cwd, taskId).length <= deliveredTurns) break;
        }
      } finally {
        resultSignal.close();
      }
      const usage = (loadTask(cwd, taskId)?.turnUsage ?? [])
        .slice(previousTurns)
        .flatMap(turn => (turn.tokens ? [turn.tokens] : []));
      result.tokens = usage.length
        ? usage.reduce((total, tokens) => addTokens(total, tokens)!)
        : (readResultJson(cwd, taskId)?.tokens ?? result.tokens);
      if (postedMessages.length) result.postedMessages = postedMessages;
    }
    await flushLogs();
    while (pendingAck) {
      timeout.throwIfAborted();
      await ack().catch(() => {});
      if (pendingAck) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await reportResult({
      status: cancelled ? 'cancelled' : result.ok ? 'completed' : 'failed',
      result: result.reply ?? result.result,
      ...(!result.ok && result.error ? { error: result.error } : {}),
      tokens: result.tokens,
      ...(approvals().length ? { approvals: approvals() } : {}),
      ...(result.postedMessages?.length ? { postedMessages: result.postedMessages } : {}),
      ...(event?.repo ? { diff: await changes(cwd, root).catch(() => undefined) } : {}),
    });
    return result;
  } catch (error) {
    if (timeout.aborted) {
      flow?.requestStop();
      const ids = new Set([
        ...(taskId ? [taskId] : []),
        ...(flow?.runningIds() ?? []),
        ...listTasks(cwd)
          .filter(
            task =>
              task.name === `${AGENT_TASK_PREFIX}${id}` || (flow && task.flowRunId === flow.runId),
          )
          .map(task => task.id),
      ]);
      for (const taskId of ids) {
        if (!logged.has(taskId))
          logged.set(taskId, createJsonlTail(path.join(resolveTaskDir(cwd, taskId), 'log.jsonl')));
        const task = loadTask(cwd, taskId);
        if (task) await stopTask(cwd, task);
      }
    }
    await flushLogs();
    throw error;
  } finally {
    for (const watcher of logWatchers.values()) watcher.close();
    await forwarding?.catch(() => {});
    clearInterval(ackTimer);
    clearInterval(shortPoll);
    controller.abort();
    await Promise.allSettled([fetching, acknowledging]);
    if (!inboxClosed) await inbox.close();
  }
}

export const INBOX_SOCKET = '/tmp/coder-inbox.sock';
export const inboxSocket = (root: string) =>
  path.join(
    os.tmpdir(),
    `coder-${createHash('sha256').update(root).digest('hex').slice(0, 24)}.sock`,
  );

export function sendInbox(socketPath: string, entries: InboxEntry[]): Promise<InboxAck> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: '/messages',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      res => {
        let raw = '';
        res.on('data', chunk => {
          raw += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200)
            return reject(new Error(`Task inbox answered ${res.statusCode}`));
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(error);
          }
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error('Task inbox timed out')));
    req.on('error', reject);
    req.end(JSON.stringify({ entries }));
  });
}

// Runs through the container or sandbox's existing authenticated command channel.
export const INBOX_COMMAND = `const http=require('node:http');const req=http.request({socketPath:process.env.CODER_INBOX_SOCKET||'/tmp/coder-inbox.sock',path:'/messages',method:'POST',headers:{'content-type':'application/json'}},res=>{res.pipe(process.stdout);res.on('end',()=>{if(res.statusCode!==200)process.exitCode=1})});req.on('error',()=>{process.exitCode=1});req.setTimeout(10000,()=>req.destroy());req.end(JSON.stringify({entries:JSON.parse(process.env.CODER_INBOX_MESSAGES)}));`;

export async function receiveInbox(options: {
  root: string;
  generation: number;
  socketPath?: string;
  apply(entry: InboxEntry): Promise<unknown>;
}) {
  const file = path.join(options.root, '.runner-inbox.json');
  const saved = readJsonFile<InboxAck>(file);
  let state: InboxAck =
    saved?.generation === options.generation
      ? saved
      : { generation: options.generation, seq: -1, answers: [] };
  let tail = Promise.resolve();
  const apply = (entries: InboxEntry[]): Promise<InboxAck> => {
    const work = async () => {
      if (
        !Array.isArray(entries) ||
        entries.some(
          entry =>
            !Number.isInteger(entry.seq) ||
            entry.seq < 0 ||
            entry.generation !== options.generation ||
            !['steer', 'ask', 'approve', 'cancel'].includes(entry.kind),
        )
      )
        throw new Error('Invalid task messages');
      for (const entry of [...entries].sort((a, b) => a.seq - b.seq)) {
        if (entry.seq <= state.seq) continue;
        const value = await options.apply(entry);
        const next: InboxAck = {
          generation: options.generation,
          seq: entry.seq,
          answers: [
            ...(state.answers ?? []),
            ...(entry.kind === 'ask' ? [{ seq: entry.seq, value }] : []),
          ],
        };
        writeJsonFileAtomic(file, next);
        state = next;
      }
      return state;
    };
    const next = tail.then(work, work);
    tail = next.then(
      () => {},
      () => {},
    );
    return next;
  };
  const socketPath =
    options.socketPath ?? process.env.CODER_INBOX_SOCKET ?? inboxSocket(options.root);
  if (
    await fs.lstat(socketPath).then(
      () => true,
      () => false,
    )
  ) {
    const stale = await new Promise<boolean>((resolve, reject) => {
      const socket = net.connect(socketPath);
      socket.once('connect', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', (error: NodeJS.ErrnoException) =>
        error.code === 'ECONNREFUSED' ? resolve(true) : reject(error),
      );
    });
    if (!stale) throw new Error('The task inbox is already running');
    await fs.unlink(socketPath);
  }
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/messages') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    try {
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Messages too large');
      }
      const ack = await apply(JSON.parse(raw).entries);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(ack));
    } catch {
      res.writeHead(409).end();
    }
  });
  await fs.mkdir(options.root, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await fs.chmod(socketPath, 0o600);
  return {
    apply,
    ack: () => state,
    close: async () => {
      await tail;
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

const UNFORWARDED = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'connection',
  'keep-alive',
  'upgrade',
  'transfer-encoding',
  'content-length',
  'content-encoding',
]);

/** The task's server for its engine's shell, on a socket only this user opens: the runner adds the attempt token, so the token never enters the engine's env. */
export async function serveTaskServer(auth: { server: string; token: string }) {
  // `/tmp`, not the task's folder or TMPDIR, keeps the path under the unix socket limit (104 bytes on macOS).
  const dir = await fs.realpath(await fs.mkdtemp('/tmp/coder-'));
  const socketPath = path.join(dir, 'server.sock');
  const server = http.createServer(
    nodeListener(async request => {
      const url = new URL(request.url);
      // The shell gets the API routes the cloud MCP calls; the runner's own `/tasks/<id>` callbacks stay the runner's.
      if (!url.pathname.startsWith('/admin/'))
        return Response.json({ error: 'Not found' }, { status: 404 });
      const target = new URL(`${auth.server}${url.pathname}${url.search}`);
      const headers = new Headers(request.headers);
      for (const name of UNFORWARDED) headers.delete(name);
      headers.set('authorization', `Bearer ${auth.token}`);
      const response = await fetch(target, {
        method: request.method,
        headers,
        body: request.body,
        duplex: 'half',
        redirect: 'manual',
        signal: request.signal,
      } as RequestInit);
      // fetch already decoded the body, so its length and encoding no longer hold.
      const answer = new Headers(response.headers);
      for (const name of UNFORWARDED) answer.delete(name);

      return new Response(response.body, { status: response.status, headers: answer });
    }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await fs.chmod(socketPath, 0o600);

  return {
    socketPath,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
