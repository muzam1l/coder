import net from 'node:net';
import { randomUUID } from 'node:crypto';

import { MACHINE_SANDBOX_ENV } from '../../core/config';
import { decodeJson, encodeJson } from '../../utils/base64url';
import { sha256 } from '../../utils/crypto';
import type { AgentTask } from '../../agent/types';
import type { Runner } from '.';
import { toolInstalls } from './local';
import { runnerHash, runnerTarball, startCommand, SETUP_FAILED } from '.';
import { INTEGRATIONS } from '../../integrations';
import { INBOX_COMMAND, INBOX_SOCKET } from '../../runner/task';
import type { InboxEntry, InboxAck } from '../tasks/queue';

type Command = {
  cmdId: string;
  exitCode: number | null;
  stdout(): Promise<string>;
  wait(opts?: { signal?: AbortSignal }): Promise<Command>;
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
  lease?: { owner: string; expiresAt: number };
}
export interface SnapshotStore {
  get(key: string): Promise<SnapshotState | undefined>;
  put(key: string, value: SnapshotState): Promise<void>;
  withLock?<T>(key: string, work: (store: SnapshotStore) => Promise<T>): Promise<T>;
}

export interface VercelSandboxOptions {
  token?: string;
  team?: string;
  projectId?: string;
  image?: string;
  timeoutMs?: number;
  vcpus?: number;
  region?: string;
  snapshots?: SnapshotStore;
  sandbox?: SandboxApi;
  now?: () => number;
}

type SandboxHandle = { sandbox: string; command: string };
const decode = (value: string) => decodeJson<SandboxHandle>(value);

const REFRESH_MS = 15 * 60 * 1000;
const BUILD_MS = 30 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
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

/** Each engine's model API, and the account hosts a subscription uses and signs in with. */
export const ENGINE_HOSTS: Record<string, { api: string; account: string[] }> = {
  claude: { api: 'api.anthropic.com', account: ['claude.ai', 'platform.claude.com'] },
  codex: { api: 'api.openai.com', account: ['auth.openai.com', 'chatgpt.com'] },
};

/** Hosts an engine reaches with a credential's variables. */
export function engineHosts(engine: string, env: Record<string, string>): string[] {
  const hosts = ENGINE_HOSTS[engine];
  const subscription = env.CLAUDE_CODE_OAUTH_TOKEN || env.CODEX_AUTH_JSON;
  const urls = [env.ANTHROPIC_BASE_URL, env.OPENAI_BASE_URL].filter(
    url => url && URL.canParse(url),
  );

  return [
    ...(hosts ? [hosts.api, ...(subscription ? hosts.account : [])] : []),
    ...urls.map(url => new URL(url!).hostname),
  ];
}

/** The machine firewall: brokered keys per host; with `hosts`, nothing else is reachable. */
export function networkPolicy(credential: Record<string, string> = {}, hosts?: string[]) {
  const rules = Object.entries(BROKERED)
    .filter(([name]) => credential[name])
    .map(([name, rule]) => [
      rule.host,
      [{ transform: [{ headers: { [rule.header]: `${rule.prefix}${credential[name]}` } }] }],
    ]);
  if (!hosts)
    return rules.length ? { allow: { ...Object.fromEntries(rules), '*': [] } } : undefined;
  const ips = [...new Set(hosts.filter(host => net.isIP(host)))];
  const domains = hosts.filter(host => !net.isIP(host)).map(host => [host, []]);

  return {
    allow: { ...Object.fromEntries(domains), ...Object.fromEntries(rules) },
    ...(ips.length
      ? { subnets: { allow: ips.map(ip => `${ip}/${net.isIPv6(ip) ? 128 : 32}`) } }
      : {}),
  };
}

/** Hosts every machine's start reaches: this server, the runner package and tool installs. */
function startHosts(env: Record<string, string>): string[] {
  return [
    ...[env.CODER_SERVER, env.CODER_RUNNER_TARBALL_URL]
      .filter(url => url && URL.canParse(url))
      .map(url => new URL(url!).hostname),
    ...Object.values(INTEGRATIONS).flatMap(integration => integration.tools.installHosts ?? []),
  ];
}

async function loadSandbox(): Promise<SandboxApi> {
  try {
    const module = (await import('@vercel/sandbox' as string)) as { Sandbox: SandboxApi };
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
  private readonly sandboxes = new Map<string, { sandbox: SandboxInstance; expiresAt: number }>();

  constructor(private readonly options: VercelSandboxOptions = {}) {}

  private api(): Promise<SandboxApi> {
    return this.options.sandbox ? Promise.resolve(this.options.sandbox) : loadSandbox();
  }

  private async sandbox(name: string) {
    for (const [key, value] of this.sandboxes)
      if (value.expiresAt <= this.now()) this.sandboxes.delete(key);
    const owned = this.sandboxes.get(name);
    return owned?.sandbox ?? (await this.api()).get({ ...this.auth(), name });
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
      resources: { vcpus: this.options.vcpus ?? 1 },
      persistent: false,
    };
  }

  /** Snapshot key per repository, install, runner build and image. */
  snapshotKey(task: AgentTask): string | undefined {
    const repo = task.event?.repo;
    if (!repo) return undefined;
    const id = [
      runnerHash(),
      this.options.image ?? null,
      task.event!.appId,
      task.event!.installationId,
      repo.owner,
      repo.name,
    ];

    return `repo:${this.options.region ?? ''}:${sha256(JSON.stringify(id))}`;
  }

  private async stopSandbox(sandbox: SandboxInstance) {
    try {
      await sandbox.stop();
    } finally {
      this.sandboxes.delete(sandbox.name);
    }
  }

  private async withSandbox<T>(
    value: string | SandboxInstance,
    run: (sandbox: SandboxInstance) => Promise<T>,
  ): Promise<T> {
    let sandbox: SandboxInstance | undefined;
    try {
      sandbox = typeof value === 'string' ? await this.sandbox(value) : value;
      if (sandbox.status !== 'running' && sandbox.status !== 'pending')
        throw new SandboxExpired(`Vercel Sandbox ${sandbox.name} is ${sandbox.status}`);

      return await run(sandbox);
    } catch (error) {
      const status = responseStatus(error);
      if ((status === 404 || status === 410) && typeof value === 'string')
        this.sandboxes.delete(value);
      if (status === 410 || (!sandbox && typeof value === 'string' && status === 404))
        throw new SandboxExpired(
          error instanceof Error ? error.message : 'Vercel Sandbox expired',
          undefined,
          { cause: error },
        );
      throw error;
    }
  }

  private withSnapshotLock<T>(key: string, work: (store: SnapshotStore) => Promise<T>): Promise<T> {
    const store = this.options.snapshots!;

    return store.withLock ? store.withLock(key, work) : work(store);
  }

  private async finalizeSnapshot(key: string, expected?: SnapshotState): Promise<SnapshotState> {
    const now = this.now();
    const owner = randomUUID();
    const state = await this.withSnapshotLock(key, async store => {
      const current = (await store.get(key)) ?? {};
      if (!current.build || (current.lease && current.lease.expiresAt > now)) return current;
      if (
        expected?.build &&
        (current.build.sandbox !== expected.build.sandbox ||
          current.build.command !== expected.build.command ||
          current.build.startedAt !== expected.build.startedAt)
      )
        return current;
      const claimed = { ...current, lease: { owner, expiresAt: now + BUILD_MS } };
      await store.put(key, claimed);

      return claimed;
    });
    if (state.lease?.owner !== owner || !state.build) return state;
    const { build, lease, ...rest } = state;
    let next: SnapshotState = { ...rest, build };
    let failure: unknown;
    try {
      next = await this.withSandbox(build.sandbox, async sandbox => {
        const command = await sandbox.getCommand(build.command);
        if (command.exitCode === null && now - build.startedAt < BUILD_MS) return next;
        if (command.exitCode === 0) {
          const sha = /^coder-snapshot (\S+)$/m.exec(await command.stdout())?.[1];
          if (sha && sha === state.sha) {
            await this.stopSandbox(sandbox).catch(() => {});
            return { ...rest, checkedAt: now };
          }
          const taken = await sandbox.snapshot({ expiration: SNAPSHOT_TTL_MS });
          this.sandboxes.delete(sandbox.name);

          return { ...rest, snapshotId: taken.snapshotId, ...(sha ? { sha } : {}), checkedAt: now };
        }
        await this.stopSandbox(sandbox).catch(() => {});

        return { ...rest, failedAt: now };
      });
    } catch (error) {
      failure = error;
      if (error instanceof SandboxExpired) {
        const { failedAt, ...usable } = rest;
        next = usable;
      }
    }
    const saved = await this.withSnapshotLock(key, async store => {
      const current = (await store.get(key)) ?? {};
      if (current.lease?.owner !== owner) return current;
      await store.put(key, next);

      return next;
    });
    if (failure) throw failure;

    return saved;
  }

  /** The newest usable snapshot for a key, starting or finishing its build on the way. */
  private async snapshot(
    key: string,
    build: (
      source?: string,
    ) => Promise<{ sandbox: string; command: string; wait(): Promise<Command> }>,
    refresh: boolean,
    waitUntil?: (work: Promise<unknown>) => void,
  ): Promise<string | undefined> {
    if (!this.options.snapshots) return undefined;
    const finalized = await this.finalizeSnapshot(key);
    if (finalized.build) return finalized.snapshotId;
    const now = this.now();
    const owner = randomUUID();
    const state = await this.withSnapshotLock(key, async store => {
      const current = (await store.get(key)) ?? {};
      const stale =
        !current.snapshotId || (refresh && now - (current.checkedAt ?? 0) >= REFRESH_MS);
      const failing = current.failedAt !== undefined && now - current.failedAt < RETRY_MS;
      if (current.build || (current.lease && current.lease.expiresAt > now) || !stale || failing)
        return current;
      const claimed = { ...current, lease: { owner, expiresAt: now + BUILD_MS } };
      await store.put(key, claimed);

      return claimed;
    });
    if (state.lease?.owner !== owner) return state.snapshotId;
    let started: Awaited<ReturnType<typeof build>> | undefined;
    let failure: unknown;
    try {
      started = await build(state.snapshotId);
    } catch (error) {
      if (error instanceof SandboxExpired) failure = error;
    }
    const saved = await this.withSnapshotLock(key, async store => {
      const current = (await store.get(key)) ?? {};
      if (current.lease?.owner !== owner) return current;
      const { lease, ...rest } = current;
      const next = {
        ...rest,
        ...(started
          ? { build: { sandbox: started.sandbox, command: started.command, startedAt: now } }
          : {}),
      };
      await store.put(key, next);

      return next;
    });
    if (started) {
      if (saved.build?.sandbox === started.sandbox && saved.build.command === started.command) {
        const work = (async () => {
          await started.wait();
          await this.finalizeSnapshot(key, saved);
        })().catch(() => {});
        waitUntil?.(work);
      } else {
        await this.withSandbox(started.sandbox, sandbox => this.stopSandbox(sandbox)).catch(
          () => {},
        );
      }
    }
    if (failure) throw failure;

    return saved.snapshotId;
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
    if (!command.env?.CODER_PREPARE) {
      for (const [key, value] of this.sandboxes)
        if (value.expiresAt <= this.now()) this.sandboxes.delete(key);
      if (this.sandboxes.size >= 1000) this.sandboxes.delete(this.sandboxes.keys().next().value!);
      this.sandboxes.set(sandbox.name, {
        sandbox,
        expiresAt: this.now() + Number(extra.timeout ?? this.options.timeoutMs ?? BUILD_MS),
      });
    }
    try {
      const started = await this.withSandbox(sandbox, sandbox =>
        sandbox.runCommand({ ...command, detached: true }),
      );

      return {
        sandbox: sandbox.name,
        command: started.cmdId,
        wait: () => started.wait({ signal: AbortSignal.timeout(BUILD_MS) }),
      };
    } catch (error) {
      this.sandboxes.delete(sandbox.name);
      await this.stopSandbox(sandbox).catch(() => {});
      throw error;
    }
  }

  async start(
    task: AgentTask,
    env: Record<string, string>,
    credential?: Record<string, string>,
    options: {
      timeoutMs?: number;
      waitUntil?: (work: Promise<unknown>) => void;
      hosts?: string[];
    } = {},
  ): Promise<string> {
    env = {
      ...env,
      [MACHINE_SANDBOX_ENV]: '1',
      CODER_RUNNER_TARBALL_URL: runnerTarball(env.CODER_SERVER!),
      CODER_RUNNER_HASH: runnerHash(),
    };
    const policy = networkPolicy(
      credential,
      options.hosts && [...startHosts(env), ...options.hosts],
    );
    const command = (env: Record<string, string>) => ({
      cmd: 'sh',
      args: [
        '-c',
        startCommand(
          toolInstalls()
            .map(install => `sudo sh -c '${install}'`)
            .join(' && '),
        ),
        'coder-task',
        task.id,
        SETUP_FAILED,
      ],
      env,
    });
    for (let attempt = 0; ; attempt++) {
      let key: string | undefined;
      try {
        key = this.snapshotKey(task);
        const source = key
          ? await this.snapshot(
              key,
              source => this.detached(source, command({ ...env, CODER_PREPARE: '1' })),
              true,
              options.waitUntil,
            )
          : undefined;

        const handle = await this.detached(
          source,
          command({ ...env, CODER_INBOX_SOCKET: INBOX_SOCKET }),
          {
            ...(policy ? { networkPolicy: policy } : {}),
            ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
          },
        );

        return encodeJson({ sandbox: handle.sandbox, command: handle.command });
      } catch (error) {
        if (!(error instanceof SandboxExpired)) throw error;
        if (key && error.snapshotId && this.options.snapshots) {
          const snapshotId = error.snapshotId;
          await this.withSnapshotLock(key, async store => {
            const state = await store.get(key!);
            if (state?.snapshotId !== snapshotId) return;
            const { snapshotId: expired, sha, checkedAt, failedAt, ...pending } = state;
            await store.put(key!, pending);
          });
        }
        if (attempt === 2) throw error;
      }
    }
  }

  async status(handle: string) {
    const value = decode(handle);
    try {
      const sandbox = await this.sandbox(value.sandbox);
      if (sandbox.status === 'pending') return { state: 'running' as const };
      if (sandbox.status !== 'running') {
        this.sandboxes.delete(value.sandbox);
        return { state: 'exited' as const, code: 1 };
      }
      const command = await sandbox.getCommand(value.command);
      return command.exitCode === null
        ? { state: 'running' as const }
        : { state: 'exited' as const, code: command.exitCode };
    } catch (error) {
      if ([404, 410].includes(responseStatus(error) ?? 0)) this.sandboxes.delete(value.sandbox);
      throw error;
    }
  }

  async push(handle: string, entries: InboxEntry[]): Promise<InboxAck> {
    return this.withSandbox(decode(handle).sandbox, async sandbox => {
      const command = await sandbox.runCommand({
        cmd: 'node',
        args: ['-e', INBOX_COMMAND],
        detached: false,
        env: { CODER_INBOX_MESSAGES: JSON.stringify(entries) },
      });
      const output = await command.stdout();
      if (command.exitCode !== 0) throw new Error('Sandbox inbox delivery failed');
      return JSON.parse(output);
    });
  }

  async stop(handle: string): Promise<void> {
    const name = decode(handle).sandbox;
    try {
      await (await this.sandbox(name)).stop();
    } finally {
      this.sandboxes.delete(name);
    }
  }
}
