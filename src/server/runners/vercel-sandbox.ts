import { readVersion } from '../../core/runtime';
import { decodeJson, encodeJson } from '../../utils/base64url';
import { sha256 } from '../../utils/crypto';
import type { AgentTask } from '../../agent/types';
import type { Runner, RunnerLogs } from '.';
import { toolInstalls } from './local';
import { INBOX_COMMAND, INBOX_SOCKET } from '../../runner/task';
import type { InboxEntry, InboxAck } from '../tasks/queue';

type Command = {
  cmdId: string;
  exitCode: number | null;
  stdout(): Promise<string>;
  wait(opts?: { signal?: AbortSignal }): Promise<Command>;
  logs(): AsyncIterable<{ stream: 'stdout' | 'stderr'; data: string }> & { close?(): void };
};
type SandboxInstance = {
  name: string;
  status: string;
  runCommand(input: {
    cmd: string;
    args: string[];
    cwd?: string;
    sudo?: boolean;
    detached: boolean;
    env?: Record<string, string>;
  }): Promise<Command>;
  getCommand(id: string): Promise<Command>;
  snapshot(opts?: { expiration?: number }): Promise<{ snapshotId: string }>;
  stop(): Promise<unknown>;
};
export type SandboxApi = {
  create(options: Record<string, unknown>): Promise<SandboxInstance>;
  get(options: {
    name: string;
    token?: string;
    teamId?: string;
    projectId?: string;
  }): Promise<SandboxInstance>;
};

/** Build state of one snapshot, stored by the server under its key. */
export interface SnapshotState {
  snapshotId?: string;
  /** Default branch commit the snapshot holds. */
  sha?: string;
  checkedAt?: number;
  failedAt?: number;
  build?: { sandbox: string; command: string; startedAt: number };
}
export interface SnapshotStore {
  get(key: string): Promise<SnapshotState | undefined>;
  put(key: string, value: SnapshotState): Promise<void>;
}

export interface VercelSandboxOptions {
  token?: string;
  team?: string;
  projectId?: string;
  image?: string;
  timeoutMs?: number;
  vcpus?: number;
  region?: string;
  /** Extra global npm packages in the base snapshot. */
  tools?: string[];
  snapshots?: SnapshotStore;
  sandbox?: SandboxApi;
  now?: () => number;
}

type SandboxHandle = { sandbox: string; command: string };
type LogStream = {
  lines: RunnerLogs['lines'];
  offset: number;
  dropped: number;
  warned: boolean;
  done: boolean;
  error?: unknown;
  close(): void;
};
const decode = (value: string) => decodeJson<SandboxHandle>(value);

const ROOT = '/vercel/sandbox';
const REFRESH_MS = 15 * 60 * 1000;
const BUILD_MS = 30 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = MAX_LOG_BYTES / 4;
const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Vercel Sandbox region per AWS region, from Vercel's region list. */
const REGIONS: Record<string, string> = {
  'eu-north-1': 'arn1',
  'ap-south-1': 'bom1',
  'eu-west-3': 'cdg1',
  'us-east-2': 'cle1',
  'af-south-1': 'cpt1',
  'eu-west-1': 'dub1',
  'eu-central-1': 'fra1',
  'sa-east-1': 'gru1',
  'ap-east-1': 'hkg1',
  'ap-northeast-1': 'hnd1',
  'us-east-1': 'iad1',
  'ap-northeast-2': 'icn1',
  'ap-northeast-3': 'kix1',
  'eu-west-2': 'lhr1',
  'us-west-2': 'pdx1',
  'us-west-1': 'sfo1',
  'ap-southeast-1': 'sin1',
  'ap-southeast-2': 'syd1',
  'ca-central-1': 'yul1',
};

/** The sandbox region nearest a database whose host names its AWS region (Neon, Supabase, RDS). */
export function nearestRegion(databaseUrl: string | undefined): string | undefined {
  if (!databaseUrl) return undefined;
  const host = (() => {
    try {
      return new URL(databaseUrl).hostname;
    } catch {
      return '';
    }
  })();
  return Object.entries(REGIONS).find(([aws]) => host.includes(aws))?.[1];
}

/** API keys the sandbox firewall injects, so the key never enters the sandbox. */
export const BROKERED: Record<string, { host: string; header: string; prefix: string }> = {
  ANTHROPIC_API_KEY: { host: 'api.anthropic.com', header: 'x-api-key', prefix: '' },
  OPENAI_API_KEY: { host: 'api.openai.com', header: 'authorization', prefix: 'Bearer ' },
};
export const BROKERED_PLACEHOLDER = 'brokered';

function networkPolicy(credential: Record<string, string> = {}) {
  const rules = Object.entries(BROKERED)
    .filter(([name]) => credential[name])
    .map(([name, rule]) => [
      rule.host,
      [{ transform: [{ headers: { [rule.header]: `${rule.prefix}${credential[name]}` } }] }],
    ]);
  return rules.length ? { allow: { ...Object.fromEntries(rules), '*': [] } } : undefined;
}

async function loadSandbox(): Promise<SandboxApi> {
  try {
    const module = (await new Function('name', 'return import(name)')('@vercel/sandbox')) as {
      Sandbox: SandboxApi;
    };
    return module.Sandbox;
  } catch {
    throw new Error('The vercel-sandbox runner requires @vercel/sandbox in the adapter app.');
  }
}

function responseStatus(error: unknown): number | undefined {
  return error &&
    typeof error === 'object' &&
    'response' in error &&
    error.response instanceof Response
    ? error.response.status
    : undefined;
}

function snapshotExpired(error: unknown): boolean {
  if (responseStatus(error) !== 410 || !error || typeof error !== 'object' || !('json' in error))
    return false;
  const body = error.json;
  if (!body || typeof body !== 'object' || !('error' in body)) return false;
  const detail = body.error;
  return (
    !!detail &&
    typeof detail === 'object' &&
    'code' in detail &&
    detail.code === 'snapshot_not_found'
  );
}

class SandboxExpired extends Error {
  constructor(
    message: string,
    readonly snapshotId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Each task gets its own microVM, started from a per-repository snapshot built on first use. */
export class VercelSandboxRunner implements Runner {
  readonly kind = 'vercel-sandbox' as const;
  private readonly streams = new Map<string, Promise<LogStream>>();

  constructor(private readonly options: VercelSandboxOptions = {}) {}

  private api(): Promise<SandboxApi> {
    return this.options.sandbox ? Promise.resolve(this.options.sandbox) : loadSandbox();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private auth() {
    return {
      ...(this.options.token
        ? {
            token: this.options.token,
            projectId: this.options.projectId ?? process.env.VERCEL_PROJECT_ID,
            teamId: this.options.team ?? process.env.VERCEL_TEAM_ID,
          }
        : {}),
    };
  }

  private base(source?: string) {
    return {
      ...(source
        ? { source: { type: 'snapshot', snapshotId: source } }
        : this.options.image
          ? { image: this.options.image }
          : {}),
      ...(this.options.region ? { region: this.options.region } : {}),
      ...this.auth(),
      resources: { vcpus: this.options.vcpus ?? 2 },
      persistent: false,
    };
  }

  /** Snapshot key per repository, scoped to its install and base snapshot. */
  snapshotKey(task: AgentTask, base?: string): string | undefined {
    const repo = task.event?.repo;
    if (!repo) return undefined;
    const id = [
      this.baseKey(),
      base ?? null,
      task.event!.appId,
      task.event!.installationId,
      repo.owner,
      repo.name,
    ];

    return `repo:${this.options.region ?? ''}:${sha256(JSON.stringify(id))}`;
  }

  private baseKey(): string {
    const id = [readVersion(), this.options.image ?? null, this.options.tools ?? []];

    return `base:${this.options.region ?? ''}:${sha256(JSON.stringify(id))}`;
  }

  private async withSandbox<T>(
    value: string | SandboxInstance,
    run: (sandbox: SandboxInstance) => Promise<T>,
  ): Promise<T> {
    let sandbox: SandboxInstance | undefined;
    try {
      sandbox =
        typeof value === 'string'
          ? await (await this.api()).get({ ...this.auth(), name: value })
          : value;
      if (sandbox.status !== 'running' && sandbox.status !== 'pending')
        throw new SandboxExpired(`Vercel Sandbox ${sandbox.name} is ${sandbox.status}`);

      return await run(sandbox);
    } catch (error) {
      const status = responseStatus(error);
      if (status === 410 || (!sandbox && typeof value === 'string' && status === 404))
        throw new SandboxExpired(
          error instanceof Error ? error.message : 'Vercel Sandbox expired',
          undefined,
          { cause: error },
        );
      throw error;
    }
  }

  private async finalizeSnapshot(key: string, state: SnapshotState): Promise<SnapshotState> {
    const store = this.options.snapshots!;
    const now = this.now();
    const { build, ...rest } = state;
    if (!build) return state;

    try {
      state = await this.withSandbox(build.sandbox, async sandbox => {
        const command = await sandbox.getCommand(build.command);
        if (command.exitCode === null && now - build.startedAt < BUILD_MS) return state;
        if (command.exitCode === 0) {
          const sha = /^coder-snapshot (\S+)$/m.exec(await command.stdout())?.[1];
          if (sha && sha === state.sha) {
            await sandbox.stop().catch(() => {});
            return { ...rest, checkedAt: now };
          }
          const taken = await sandbox.snapshot({ expiration: SNAPSHOT_TTL_MS });

          return { ...rest, snapshotId: taken.snapshotId, ...(sha ? { sha } : {}), checkedAt: now };
        }
        await sandbox.stop().catch(() => {});

        return { ...rest, failedAt: now };
      });
    } catch (error) {
      if (error instanceof SandboxExpired) {
        const { failedAt, ...usable } = rest;
        const current = await store.get(key);
        if (
          current?.build?.sandbox === build.sandbox &&
          current.build.command === build.command &&
          current.build.startedAt === build.startedAt
        )
          await store.put(key, usable);
      }
      throw error;
    }
    if (state.build) return state;
    const current = await store.get(key);
    if (
      current?.build?.sandbox !== build.sandbox ||
      current.build.command !== build.command ||
      current.build.startedAt !== build.startedAt
    )
      return current ?? {};
    await store.put(key, state);

    return state;
  }

  /** The newest usable snapshot for a key, starting or finishing its build on the way. */
  private async snapshot(
    key: string,
    build: (
      source?: string,
    ) => Promise<{ sandbox: string; command: string; wait(): Promise<Command> }>,
    refresh: boolean,
    source?: string,
  ): Promise<string | undefined> {
    const store = this.options.snapshots;
    if (!store) return undefined;
    const now = this.now();
    const state = await this.finalizeSnapshot(key, (await store.get(key)) ?? {});
    if (state.build) return state.snapshotId;
    const stale = !state.snapshotId || (refresh && now - (state.checkedAt ?? 0) >= REFRESH_MS);
    const failing = state.failedAt !== undefined && now - state.failedAt < RETRY_MS;
    if (stale && !failing) {
      const started = await build(state.snapshotId ?? source).catch(error => {
        if (error instanceof SandboxExpired) throw error;
        return undefined;
      });
      if (started) {
        const build = { sandbox: started.sandbox, command: started.command, startedAt: now };
        await store.put(key, { ...state, build });
        void (async () => {
          await started.wait();
          const current = await store.get(key);
          if (
            current?.build?.sandbox === build.sandbox &&
            current.build.command === build.command &&
            current.build.startedAt === build.startedAt
          )
            await this.finalizeSnapshot(key, current);
        })().catch(() => {});
      }
    }

    return state.snapshotId;
  }

  private async detached(
    source: string | undefined,
    command: { cmd: string; args: string[]; sudo?: boolean; env?: Record<string, string> },
    extra: Record<string, unknown> = {},
  ) {
    const sandbox = await (
      await this.api()
    )
      .create({
        ...this.base(source),
        timeout: this.options.timeoutMs ?? 30 * 60 * 1000,
        ...extra,
      })
      .catch(error => {
        if (source && snapshotExpired(error))
          throw new SandboxExpired(error.message, source, { cause: error });
        throw error;
      });
    try {
      const started = await this.withSandbox(sandbox, sandbox =>
        sandbox.runCommand({ ...command, cwd: ROOT, detached: true }),
      );

      return {
        sandbox: sandbox.name,
        command: started.cmdId,
        wait: () => started.wait({ signal: AbortSignal.timeout(BUILD_MS) }),
      };
    } catch (error) {
      await sandbox.stop().catch(() => {});
      throw error;
    }
  }

  async start(
    task: AgentTask,
    env: Record<string, string>,
    credential?: Record<string, string>,
  ): Promise<string> {
    const coder = `@wular/coder@${readVersion()}`;
    const install = [
      `npm install -g @anthropic-ai/claude-code @openai/codex bun ${[coder, ...(this.options.tools ?? [])].join(' ')}`,
      ...toolInstalls(),
    ].join(' && ');
    const command = (source: string | undefined, env: Record<string, string>) => ({
      cmd: source ? 'coder' : 'sh',
      args: source
        ? ['agent', 'run', '--task', task.id]
        : [
            '-c',
            'sudo -E sh -c "$1" && exec coder agent run --task "$2"',
            'coder-task',
            install,
            task.id,
          ],
      env,
    });
    const baseKey = this.baseKey();
    const policy = networkPolicy(credential);
    for (let attempt = 0; ; attempt++) {
      let key: string | undefined;
      try {
        const base = await this.snapshot(
          baseKey,
          () =>
            this.detached(undefined, {
              cmd: 'sh',
              args: ['-c', install],
              sudo: true,
            }),
          false,
        );
        key = this.snapshotKey(task, base);
        const repo = key
          ? await this.snapshot(
              key,
              source => this.detached(source, command(source, { ...env, CODER_PREPARE: '1' })),
              true,
              base,
            )
          : undefined;
        const source = repo ?? base;

        const handle = await this.detached(
          source,
          command(source, { ...env, CODER_INBOX_SOCKET: INBOX_SOCKET }),
          policy ? { networkPolicy: policy } : {},
        );

        return encodeJson({ sandbox: handle.sandbox, command: handle.command });
      } catch (error) {
        if (!(error instanceof SandboxExpired)) throw error;
        for (const id of [baseKey, key]) {
          if (!id || !error.snapshotId) continue;
          const state = await this.options.snapshots?.get(id);
          if (state?.snapshotId === error.snapshotId)
            await this.options.snapshots!.put(id, state.build ? { build: state.build } : {});
        }
        if (attempt === 2) throw error;
      }
    }
  }

  async status(handle: string) {
    const value = decode(handle);
    const sandbox = await (await this.api()).get({ ...this.auth(), name: value.sandbox });
    if (sandbox.status === 'pending') return { state: 'running' as const };
    if (sandbox.status !== 'running') return { state: 'exited' as const, code: 1 };
    const command = await sandbox.getCommand(value.command);
    return command.exitCode === null
      ? { state: 'running' as const }
      : { state: 'exited' as const, code: command.exitCode };
  }

  async push(handle: string, entries: InboxEntry[]): Promise<InboxAck> {
    const sandbox = await (await this.api()).get({ ...this.auth(), name: decode(handle).sandbox });
    const command = await sandbox.runCommand({
      cmd: 'node',
      args: ['-e', INBOX_COMMAND],
      detached: false,
      env: { CODER_INBOX_MESSAGES: JSON.stringify(entries) },
    });
    const output = await command.stdout();
    if (command.exitCode !== 0) throw new Error('Sandbox inbox delivery failed');
    return JSON.parse(output);
  }

  /** One streaming read per task instead of polling the control plane. */
  async logs(handle: string, after = -1) {
    let pending = this.streams.get(handle);
    if (!pending) {
      pending = this.readStream(handle);
      this.streams.set(handle, pending);
      void pending.catch(() => {
        if (this.streams.get(handle) === pending) this.streams.delete(handle);
      });
    }
    const stream = await pending;
    const deadline = Date.now() + 250;
    // A result callback can arrive while final log pages are still streaming.
    while (!stream.done && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, Math.min(10, deadline - Date.now())));
    if (stream.error) {
      this.streams.delete(handle);
      throw stream.error;
    }
    const lines = stream.lines.slice(Math.max(0, after + 1 - stream.offset));
    const next = Math.max(after, stream.offset + stream.lines.length - 1);
    if (lines.length && stream.dropped && !stream.warned) {
      lines.unshift({
        level: 'err',
        line: `Sandbox log buffer dropped ${stream.dropped} bytes; showing the retained tail.`,
      });
      stream.warned = true;
    }
    if (stream.done && !lines.length) this.streams.delete(handle);

    return { lines, next };
  }

  private async readStream(handle: string) {
    const value = decode(handle);
    const sandbox = await (await this.api()).get({ ...this.auth(), name: value.sandbox });
    const command = await sandbox.getCommand(value.command);
    const logs = command.logs();
    const current: LogStream = {
      lines: [],
      offset: 0,
      dropped: 0,
      warned: false,
      done: false,
      close: () => logs.close?.(),
    };
    void (async () => {
      const partial = { stdout: '', stderr: '' };
      let bytes = 0;
      const tail = (text: string) => {
        if (Buffer.byteLength(text) <= MAX_LINE_BYTES) return text;
        const buffer = Buffer.from(text);
        let start = buffer.length - MAX_LINE_BYTES;
        while ((buffer[start]! & 0xc0) === 0x80) start++;
        current.dropped += start;

        return buffer.subarray(start).toString();
      };
      const push = (name: 'stdout' | 'stderr', text: string) => {
        const parts = (partial[name] + text).split(/\r?\n/);
        partial[name] = tail(parts.pop() ?? '');
        for (const part of parts.filter(Boolean)) {
          const line = tail(part);
          current.lines.push({ level: name === 'stdout' ? 'out' : 'err', line });
          bytes += Buffer.byteLength(line) + 32;
        }
        let removed = 0;
        // Reserve half the budget for unfinished stdout and stderr.
        while (bytes > MAX_LOG_BYTES / 2 && removed < current.lines.length) {
          const size = Buffer.byteLength(current.lines[removed++]!.line);
          bytes -= size + 32;
          current.dropped += size;
        }
        if (removed) {
          current.lines.splice(0, removed);
          current.offset += removed;
        }
      };
      for await (const log of logs) push(log.stream, log.data);
      push('stdout', '\n');
      push('stderr', '\n');
    })()
      .catch(error => {
        current.error = error;
      })
      .finally(() => (current.done = true));

    return current;
  }

  async stop(handle: string): Promise<void> {
    void this.streams.get(handle)?.then(
      stream => stream.close(),
      () => {},
    );
    this.streams.delete(handle);
    await (await (await this.api()).get({ ...this.auth(), name: decode(handle).sandbox })).stop();
  }
}
