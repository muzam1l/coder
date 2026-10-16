import process from 'node:process';

import type { AgentTask } from '../../agent/types';
import type { Runner } from '.';
import { runProcess } from './local';
import { RUNNER_IMAGE, runnerTarball, startCommand, SETUP_FAILED } from '.';
import { INBOX_COMMAND, INBOX_SOCKET } from '../../runner/task';
import type { InboxEntry, InboxAck } from '../tasks/queue';

export interface DockerOptions {
  image?: string;
  memory?: string;
  cpus?: string | number;
  pidsLimit?: number;
  network?: string;
}

/** `docker run` values are argument-array entries; secret values arrive through spawn env. */
export function buildDockerArgs(
  task: AgentTask,
  env: Record<string, string>,
  options: DockerOptions = {},
): { args: string[]; env: Record<string, string> } {
  const name = `coder-${task.id.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 48)}-${Date.now()}`;
  env = {
    ...env,
    CODER_RUNNER_IMAGE: options.image ?? RUNNER_IMAGE,
    CODER_RUNNER_TARBALL_URL: runnerTarball(env.CODER_SERVER!),
  };
  const envArgs = Object.keys(env).flatMap(key => ['-e', key]);
  return {
    args: [
      'run',
      '-d',
      '--name',
      name,
      '--memory',
      String(options.memory ?? '4g'),
      '--cpus',
      String(options.cpus ?? 2),
      '--pids-limit',
      String(options.pidsLimit ?? 512),
      '--network',
      options.network ?? 'bridge',
      ...envArgs,
      options.image ?? RUNNER_IMAGE,
      'sh',
      '-c',
      startCommand(
        '',
        'for binary in node bun git curl tar claude codex github-mcp-server; do command -v "$binary" >/dev/null 2>&1 || { printf "Docker image %s is missing required binary %s\\n" "$CODER_RUNNER_IMAGE" "$binary"; exit 127; }; done',
      ),
      'coder-task',
      task.id,
      SETUP_FAILED,
    ],
    env,
  };
}

export class DockerRunner implements Runner {
  readonly kind = 'local-docker' as const;

  constructor(private readonly options: DockerOptions = {}) {}

  async start(task: AgentTask, env: Record<string, string>): Promise<string> {
    const built = buildDockerArgs(task, { ...env, CODER_INBOX_SOCKET: INBOX_SOCKET }, this.options);
    const result = await runProcess('docker', built.args, {
      PATH: process.env.PATH ?? '',
      ...built.env,
    });
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'docker run failed');
    return result.stdout.trim();
  }

  async status(handle: string) {
    const result = await runProcess(
      'docker',
      ['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', handle],
      { PATH: process.env.PATH ?? '' },
    );
    if (result.code !== 0) return { state: 'exited' as const };
    const [running, code] = result.stdout.trim().split(/\s+/);
    return running === 'true'
      ? { state: 'running' as const }
      : { state: 'exited' as const, code: Number(code) || 0 };
  }

  async stop(handle: string): Promise<void> {
    await runProcess('docker', ['rm', '-f', handle], { PATH: process.env.PATH ?? '' });
  }

  async push(handle: string, entries: InboxEntry[]): Promise<InboxAck> {
    const result = await runProcess(
      'docker',
      ['exec', '-e', 'CODER_INBOX_MESSAGES', handle, 'node', '-e', INBOX_COMMAND],
      {
        PATH: process.env.PATH ?? '',
        CODER_INBOX_MESSAGES: JSON.stringify(entries),
      },
    );
    if (result.code !== 0) throw new Error('Docker inbox delivery failed');
    return JSON.parse(result.stdout);
  }
}
