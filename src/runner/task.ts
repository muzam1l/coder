/** Runs one server task on this machine: fetch it, check out its repository, run the agent, report back. */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';

import { execAgent } from '../agent/exec';
import { INTEGRATIONS } from '../integrations';
import { tokenEnvName } from '../agent/mcp';
import type { AgentTask } from '../agent/types';
import type { EngineCredential } from '../server/store/types';
import { answerApproval } from '../core/approvals';
import { WORKSPACE_CONFIG_ENV, type CoderConfig } from '../core/config';
import { loadTask, resolveTaskDir, coderCache, enqueueSteer, readTaskLog } from '../core/state';
import { askTask, steerTask, stopTask } from '../core/task/actions';
import type { InboxEntry, InboxAck } from '../server/tasks/queue';
import { askWorker, serveMailbox, mailboxId, type MailboxKey } from '../core/mailbox';
import type { Task } from '../core/types';
import { readJsonFile, writeJsonFileAtomic } from '../utils/fsx';

const exec = promisify(execFile);
type RemoteTask = {
  task: AgentTask;
  generation: number;
  tokens: Record<string, string>;
  credential: EngineCredential;
  config?: Partial<CoderConfig>;
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
): Promise<string> {
  const repo = task.event?.repo;
  if (!repo) return root;
  const cwd = path.join(root, 'repo');
  if (!validRef(repo.ref) || !validRef(repo.defaultBranch))
    throw new Error('Invalid repository ref');
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
    const gitOptions = { ...options, maxBuffer: 64 * 1024 * 1024 };
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
        await exec('git', ['-C', cache, 'fetch', '--depth', '50', 'origin', repo.ref], gitOptions);
        await exec(
          'git',
          ['-C', cache, 'worktree', 'add', '--detach', cwd, 'FETCH_HEAD'],
          gitOptions,
        );
      });
      return cwd;
    }
    // A sandbox snapshot already holds the clone.
    const cloned = await fs
      .stat(path.join(cwd, '.git'))
      .then(() => true)
      .catch(() => false);
    if (!cloned) await exec('git', ['clone', '--depth', '50', repo.cloneUrl, cwd], gitOptions);
    await exec('git', ['-C', cwd, 'fetch', '--depth', '50', 'origin', repo.ref], gitOptions);
    await exec('git', ['-C', cwd, 'checkout', '--detach', 'FETCH_HEAD'], gitOptions);
    await exec(
      'git',
      ['-C', cwd, 'fetch', '--depth', '50', 'origin', repo.defaultBranch],
      gitOptions,
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
  await fs.mkdir(path.dirname(cache), { recursive: true });
  const lock = `${cache}.lock`;
  const staging = await fs.mkdtemp(`${lock}-`);
  const owner = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + 5 * 60_000;
  let acquired = false;
  try {
    await fs.mkdir(path.join(staging, owner));
    for (;;) {
      try {
        await fs.rename(staging, lock);
        acquired = true;
        break;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
        for (const entry of await fs.readdir(lock).catch(() => [])) {
          const pid = Number(entry.split('-')[0]);
          if (!Number.isInteger(pid) || pid <= 0) continue;
          try {
            process.kill(pid, 0);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH')
              await fs.rmdir(path.join(lock, entry)).catch(() => {});
          }
        }
        await fs.rmdir(lock).catch(() => {});
        if (Date.now() >= deadline) throw new Error('Repository cache lock timed out');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    return await work();
  } finally {
    if (acquired) {
      await fs.rmdir(path.join(lock, owner));
      await fs.rmdir(lock).catch(() => {});
    } else await fs.rm(staging, { recursive: true, force: true });
  }
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

/** What the task changed in its checkout, new files included. */
async function changes(cwd: string): Promise<string> {
  const options = { maxBuffer: 64 * 1024 * 1024 };
  await exec('git', ['-C', cwd, 'add', '--intent-to-add', '--all'], options);
  const { stdout } = await exec('git', ['-C', cwd, 'diff', 'HEAD'], options);
  return Buffer.byteLength(stdout) > MAX_DIFF_BYTES
    ? `${Buffer.from(stdout).subarray(0, MAX_DIFF_BYTES).toString()}\n[diff truncated]`
    : stdout;
}

/** Returns the task's own `CODEX_HOME` when the credential is a Codex sign-in. */
async function applyEnvironment(remote: RemoteTask, root: string): Promise<string | undefined> {
  delete process.env.CODER_SERVER;
  delete process.env.CODER_TASK_TOKEN;
  delete process.env.APP_TOKEN;
  for (const id of Object.keys(remote.tokens)) delete process.env[tokenEnvName(id)];
  const { CODEX_AUTH_JSON: authJson, ...env } = remote.credential.env;
  Object.assign(process.env, env);
  process.env[WORKSPACE_CONFIG_ENV] = JSON.stringify(remote.config ?? {});
  if (!authJson) return undefined;
  const home = await fs.mkdtemp(path.join(root, '.codex-'));
  await fs.writeFile(path.join(home, 'auth.json'), authJson, { mode: 0o600 });
  process.env.CODEX_HOME = home;
  return home;
}

/** Codex rotates its tokens; hand the new `auth.json` back so the next task starts from it. */
async function writeBack(
  auth: { server: string; token: string },
  id: string,
  remote: RemoteTask,
  home: string | undefined,
): Promise<void> {
  if (!home) return;
  const authJson = await fs.readFile(path.join(home, 'auth.json'), 'utf8').catch(() => '');
  if (authJson && authJson !== remote.credential.env.CODEX_AUTH_JSON)
    await taskRequest(auth.server, auth.token, id, '/credential', {
      method: 'POST',
      body: JSON.stringify({ authJson }),
    }).catch(() => {});
  await fs.rm(home, { recursive: true, force: true });
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
  const cwd = await checkout(
    {
      ...remote.task,
      event: { ...event, repo: { ...event.repo, ref: event.repo.defaultBranch } },
    },
    root,
    remote.tokens[event.integration],
  );
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

export async function applyTaskMessage(
  cwd: string,
  task: Task,
  entry: InboxEntry,
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
    if (!task.threadId) enqueueSteer(cwd, task.id, text);
    else await steerTask(cwd, task, text, { command });
  } else if (entry.kind === 'ask') {
    const result = await askTask(cwd, task, String(value?.question ?? entry.value ?? ''), {
      command,
    });
    return result.finalMessage ?? result.error?.message ?? '';
  } else if (entry.kind === 'approve')
    answerApproval(
      resolveTaskDir(cwd, task.id),
      String(value?.approvalId ?? value?.id ?? ''),
      value?.decision === 'deny' || value?.decision === 'decline' ? 'decline' : 'accept',
    );
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.appendFile(transcript, JSON.stringify({ command, result: null }) + '\n');
}

export async function runTask(id: string, root: string): Promise<unknown> {
  const auth = taskServer();
  const remote = await taskRequest<RemoteTask>(auth.server, auth.token, id);
  const event = remote.task.event;
  const eventToken = event && remote.tokens[event.integration];
  const polling = process.env.CODER_INBOX_MODE === 'poll';
  delete process.env.CODER_INBOX_MODE;
  const cache = process.env.CODER_CHECKOUT_CACHE;
  delete process.env.CODER_CHECKOUT_CACHE;
  const codexHome = await applyEnvironment(remote, root);
  let cwd: string | undefined;
  try {
    cwd = await checkout(remote.task, root, eventToken, cache);
    return await runCheckedOutTask(id, root, auth, remote, cwd, eventToken, polling);
  } finally {
    try {
      if (cwd) await releaseCheckout(cwd);
    } finally {
      await writeBack(auth, id, remote, codexHome);
      delete process.env[WORKSPACE_CONFIG_ENV];
    }
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
): Promise<unknown> {
  const event = remote.task.event;
  const controller = new AbortController();
  let taskId: string | undefined;
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
  const savedTask = readJsonFile<{ generation: number; id: string }>(
    path.join(root, '.runner-task.json'),
  );
  if (savedTask?.generation !== remote.generation)
    await fs.writeFile(path.join(root, '.runner-note'), remote.task.context?.note ?? '', {
      mode: 0o600,
    });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let logTimer: ReturnType<typeof setInterval> | undefined;
  const logged = new Map<string, number>();
  const forwardLogs = () => {
    for (const [id, after] of logged) {
      const entries = readTaskLog(cwd, id, Infinity);
      for (const entry of entries.slice(after)) process.stdout.write(`${JSON.stringify(entry)}\n`);
      logged.set(id, entries.length);
    }
  };
  let shortPoll: ReturnType<typeof setInterval> | undefined;
  let fetching: Promise<unknown> | undefined;
  try {
    const result = await execAgent({
      cwd,
      ...(savedTask?.generation === remote.generation ? { resumeTaskId: savedTask.id } : {}),
      noteFile: path.join(root, '.runner-note'),
      agent: remote.task.agent,
      flow: remote.task.flow,
      task: remote.task,
      toolEnvironment: { tokens: remote.tokens },
      post: remote.task.source === event?.integration,
      ...(eventToken ? { postToken: eventToken } : {}),
      async onTask(started) {
        taskId = started;
        if (!logged.has(started)) logged.set(started, 0);
        forwardLogs();
        logTimer ??= setInterval(forwardLogs, 1000);
        writeJsonFileAtomic(path.join(root, '.runner-task.json'), {
          generation: remote.generation,
          id: started,
        });
        await ack().catch(() => {});
        await fetchMessages().catch(() => {});
        clearInterval(heartbeat);
        heartbeat = setInterval(() => {
          void taskRequest(auth.server, auth.token, id, '/heartbeat', {
            method: 'POST',
            signal: controller.signal,
          }).catch(() => {});
        }, 30_000);
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
      onApproval(approval) {
        return taskRequest(auth.server, auth.token, id, '/result', {
          method: 'POST',
          body: JSON.stringify({ status: 'waiting', approval }),
        });
      },
    });
    forwardLogs();
    while (pendingAck) {
      await ack().catch(() => {});
      if (pendingAck) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await taskRequest(auth.server, auth.token, id, '/result', {
      method: 'POST',
      body: JSON.stringify({
        status: cancelled ? 'cancelled' : result.ok ? 'completed' : 'failed',
        result: result.reply ?? result.result,
        tokens: result.tokens,
        ...(result.note !== undefined ? { note: result.note } : {}),
        ...(cwd !== root ? { diff: await changes(cwd).catch(() => undefined) } : {}),
      }),
    });
    return result;
  } catch (error) {
    const value = error as {
      code?: string;
      approval?: unknown;
      message?: string;
    };
    forwardLogs();
    await taskRequest(auth.server, auth.token, id, '/result', {
      method: 'POST',
      body: JSON.stringify({
        status: 'failed',
        error: value.message ?? String(error),
      }),
    });
    throw error;
  } finally {
    clearInterval(logTimer);
    forwardLogs();
    clearInterval(ackTimer);
    clearInterval(heartbeat);
    clearInterval(shortPoll);
    controller.abort();
    await Promise.allSettled([fetching, acknowledging]);
    await inbox.close();
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
