import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { channel } from 'node:diagnostics_channel';

import type { Availability } from '../core/types';

export function processTiming(stage: string, data?: Record<string, unknown>): void {
  const timing = channel('coder.timing');
  if (timing.hasSubscribers) timing.publish({ at: Date.now(), pid: process.pid, stage, ...data });
}

/** Options accepted by runCommand and friends. */
interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  maxBuffer?: number;
  stdio?: import('node:child_process').StdioOptions;
}

/** The normalized result of a spawnSync call. */
interface CommandResult {
  command: string;
  args: string[];
  status: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: (Error & { code?: string }) | null;
}

function runCommand(
  command: string,
  args: string[] = [],
  options: RunCommandOptions = {},
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? 'pipe',
    shell: process.platform === 'win32' ? process.env.SHELL || true : false,
    windowsHide: true,
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

export function binaryAvailable(
  command: string,
  versionArgs: string[] = ['--version'],
  options: RunCommandOptions = {},
): Availability {
  const result = runCommand(command, versionArgs, options);
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return { available: false, detail: 'not found' };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || 'ok' };
}

interface RerunResult {
  error?: NodeJS.ErrnoException;
  status: number | null;
  signal: NodeJS.Signals | null;
}

/** Run this process's argv again under `command`, forwarding SIGINT and SIGTERM. */
export function rerunWith(command: string): Promise<RerunResult> {
  return new Promise(resolve => {
    const child = spawn(command, process.argv.slice(1), {
      env: process.env,
      shell: false,
      stdio: 'inherit',
    });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);

    const finish = (result: RerunResult) => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      resolve(result);
    };
    child.once('error', error => finish({ error, status: null, signal: null }));
    child.once('close', (status, signal) => finish({ status, signal }));
  });
}
