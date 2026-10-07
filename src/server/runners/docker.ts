import process from 'node:process';

import type { AgentTask } from '../../agent/types';
import type { Runner } from '.';
import { logLines, runProcess } from './local';
import { INBOX_COMMAND, INBOX_SOCKET } from '../../runner/task';
import type { InboxEntry, InboxAck } from '../tasks/queue';

const DEFAULT_IMAGE = 'node:22';

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
      options.image ?? DEFAULT_IMAGE,
      'coder',
      'agent',
      'run',
      '--task',
      task.id,
    ],
    env,
  };
}

export class DockerRunner implements Runner {
  readonly kind = 'local-docker' as const;

  constructor(private readonly options: DockerOptions = {}) {}

  async start(task: AgentTask, env: Record<string, string>): Promise<string> {
    const image = this.options.image ?? DEFAULT_IMAGE;
    const checked = await runProcess(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--entrypoint',
        'sh',
        image,
        '-c',
        'for binary in node coder claude codex; do command -v "$binary" >/dev/null 2>&1 || { printf "%s\\n" "$binary"; exit 127; }; done',
      ],
      { PATH: process.env.PATH ?? '' },
    );
    if (checked.code !== 0) {
      if (checked.code === 127 && checked.stdout.trim())
        throw new Error(
          `Docker image ${image} is missing required binary ${checked.stdout.trim()}`,
        );
      throw new Error(
        `Docker image ${image} validation failed: ${checked.stderr.trim() || 'docker run failed'}`,
      );
    }

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

  async logs(handle: string, after = -1) {
    const result = await runProcess('docker', ['logs', '--timestamps', handle], {
      PATH: process.env.PATH ?? '',
    });
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'docker logs failed');
    const all = [...logLines(result.stdout), ...logLines(result.stderr, 'err')]
      .map(({ level, line }) => {
        const space = line.indexOf(' ');
        const timestamp = line.slice(0, space);
        return { level, line: line.slice(space + 1), timestamp, at: Date.parse(timestamp) };
      })
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .map(({ timestamp, ...line }) => line);
    return { lines: all.slice(after + 1), next: all.length - 1 };
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
