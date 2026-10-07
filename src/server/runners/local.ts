import { spawn, type ChildProcess, execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { CLI_PATH } from '../../core/runtime';
import { decodeJson, encodeJson } from '../../utils/base64url';
import type { AgentTask } from '../../agent/types';
import type { Runner } from '.';
import { INTEGRATIONS } from '../../integrations';
import type { TaskLogLine } from '../store/types';
import type { InboxEntry, InboxAck } from '../tasks/queue';
import { checkoutCache, releaseCheckout, inboxSocket, sendInbox } from '../../runner/task';

type LocalHandle = { pid: number; dir: string; started: string };
const exec = promisify(execFile);

async function processIdentity(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  }
  const result = await exec('ps', ['-p', String(pid), '-o', 'lstart=']).catch(() => undefined);
  return result?.stdout.trim() || undefined;
}

function decode(handle: string): LocalHandle {
  const value = decodeJson<Partial<LocalHandle>>(handle);
  if (
    !Number.isInteger(value.pid) ||
    typeof value.dir !== 'string' ||
    typeof value.started !== 'string'
  )
    throw new Error('Invalid local runner handle');
  return value as LocalHandle;
}

/** Detached local runner for a single-tenant development server. */
export class LocalRunner implements Runner {
  readonly kind = 'local' as const;
  private readonly children = new Map<number, { child: ChildProcess; code?: number | null }>();

  constructor(private readonly workDir: string) {}

  async start(task: AgentTask, env: Record<string, string>): Promise<string> {
    await fsp.mkdir(this.workDir, { recursive: true });
    const dir = await fsp.mkdtemp(path.join(this.workDir, 'task-'));
    const cache = task.runner === 'local' ? checkoutCache(task) : undefined;
    const log = fs.openSync(path.join(dir, 'runner.log'), 'a');
    const child = spawn(process.execPath, [CLI_PATH, 'agent', 'run', '--task', task.id], {
      cwd: dir,
      detached: true,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        TMPDIR: process.env.TMPDIR ?? '',
        ...(process.env.CODER_HOME ? { CODER_HOME: process.env.CODER_HOME } : {}),
        ...env,
        ...(cache ? { CODER_CHECKOUT_CACHE: cache } : {}),
        CODER_INBOX_SOCKET: inboxSocket(dir),
      },
      stdio: ['ignore', log, log],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    fs.closeSync(log);
    const state = { child } as { child: ChildProcess; code?: number | null };
    this.children.set(child.pid!, state);
    child.once('close', code => {
      state.code = code;
      void releaseCheckout(path.join(dir, 'repo')).catch(error =>
        console.error('coder runner: checkout cleanup failed', error),
      );
    });
    child.unref();
    const started = await processIdentity(child.pid!);
    if (!started) throw new Error('Could not identify the local runner process');
    return encodeJson({ pid: child.pid!, dir, started } satisfies LocalHandle);
  }

  async status(handle: string) {
    const { pid, dir, started } = decode(handle);
    const known = this.children.get(pid);
    if (known?.code === undefined) {
      try {
        process.kill(pid, 0);
        if ((await processIdentity(pid)) === started) return { state: 'running' as const };
      } catch {}
    }
    await releaseCheckout(path.join(dir, 'repo'));
    return {
      state: 'exited' as const,
      ...(known?.code == null ? {} : { code: known.code }),
    };
  }

  async logs(handle: string, after = -1) {
    const { dir } = decode(handle);
    const output = await fsp.readFile(path.join(dir, 'runner.log'), 'utf8').catch(() => '');
    const all = logLines(output);
    return { lines: all.slice(after + 1), next: all.length - 1 };
  }

  async stop(handle: string): Promise<void> {
    const { pid, started } = decode(handle);
    // A reused PID belongs to another process.
    if ((await processIdentity(pid)) !== started) return;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }
  }

  async push(handle: string, entries: InboxEntry[]): Promise<InboxAck> {
    const { pid, dir, started } = decode(handle);
    if ((await processIdentity(pid)) !== started) throw new Error('The task process exited');
    return sendInbox(inboxSocket(dir), entries);
  }
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run one executable directly. Runner code never delegates parsing to a shell. */
export function runProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += String(chunk)));
    child.stderr.on('data', chunk => (stderr += String(chunk)));
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

/** Shell commands installing every integration's tool server binary. */
export function toolInstalls(): string[] {
  return Object.values(INTEGRATIONS).flatMap(integration =>
    integration.tools.install ? [`(${integration.tools.install})`] : [],
  );
}

export function logLines(output: string, level: TaskLogLine['level'] = 'out') {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => ({ level, line }));
}
