import { execFile } from 'node:child_process';
import { readVersion } from '../../core/runtime';
import type { RunnerSpec, RunnerTest } from '../../client/types';
import type { AgentTask, RunnerKind } from '../../agent/types';
import type { RunnerRecord, Store } from '../store/types';
import type { ServerContext } from '../context';
import type { InboxEntry, InboxAck } from '../tasks/queue';
import { decryptSecret } from '../store/secrets';
import { DockerRunner, type DockerOptions } from './docker';
import { GithubActionsRunner } from './github-actions';
import { HttpRunner } from './http';
import { LocalRunner } from './local';
import {
  VercelSandboxRunner,
  type VercelSandboxOptions,
  type SnapshotStore,
} from './vercel-sandbox';

export const RUNNER_IMAGE = 'ghcr.io/muzam1l/coder-runner:latest';
export const runnerTarball = () =>
  `https://registry.npmjs.org/@wular/coder/-/coder-${encodeURIComponent(readVersion())}.tgz`;

export const SETUP_FAILED = `
const [file, id] = process.argv.slice(1);
const lines = require('fs').readFileSync(file, 'utf8').split('\\n').map(line => line.trim()).filter(Boolean);
const error = 'The machine failed: ' + lines.slice(-6).join(' ').slice(-800);
const login = process.env.CODER_LOGIN;
const url = process.env.CODER_SERVER.replace(/\\/+$/, '') + (login ? '/logins/' : '/tasks/') + encodeURIComponent(id) + (login ? '' : '/result');
fetch(url, {
  method: 'POST', signal: AbortSignal.timeout(10000),
  headers: { authorization: 'Bearer ' + process.env.CODER_TASK_TOKEN, 'content-type': 'application/json' },
  body: JSON.stringify(login ? { error } : { status: 'failed', error }),
}).then(response => { if (!response.ok) process.exitCode = 1; }).catch(() => { process.exitCode = 1; });
`;

export function startCommand(tools = ''): string {
  const run = [
    'mkdir -p .coder-runner',
    `curl -fsSL --retry 2 --connect-timeout 10 --max-time 30 "\${CODER_RUNNER_TARBALL_URL:-${runnerTarball()}}" -o .coder-runner/package.tgz`,
    'tar -xzf .coder-runner/package.tgz -C .coder-runner',
    ...(tools ? [tools] : []),
    'bun .coder-runner/package/bin/coder.mjs agent run --task "$1"',
  ].join(' && ');

  return [
    'out=$(mktemp)',
    `{ (${run}) 2>&1; echo $? >"$out.status"; } | tee "$out"`,
    'status=$(cat "$out.status")',
    '[ "$status" = 0 ] || { [ -n "$CODER_PREPARE" ] || node -e "$2" "$out" "$1"; }',
    'rm -f "$out" "$out.status"',
    'exit "$status"',
  ].join('; ');
}

export const RUNNER_KINDS: RunnerKind[] = [
  'local',
  'local-docker',
  'vercel-sandbox',
  'github-actions',
  'http',
];

export function runnerSnapshots(store: Store, prefix = ''): SnapshotStore {
  return {
    get: key => store.get('snapshot', `${prefix}${key}`),
    put: (key, value) => store.put('snapshot', `${prefix}${key}`, value),
    withLock: (key, work) =>
      store.withAppLock(`snapshot:${prefix}${key}`, locked =>
        work({
          get: key => locked.get('snapshot', `${prefix}${key}`),
          put: (key, value) => locked.put('snapshot', `${prefix}${key}`, value),
        }),
      ),
  };
}

export function createRunners(opts: {
  kind: RunnerKind;
  workDir: string;
  config?: Record<string, unknown>;
  local?: boolean;
  sandbox?: VercelSandboxOptions;
}): Partial<Record<RunnerKind, Runner>> {
  const kind = opts.kind;
  if (opts.local === false && (kind === 'local' || kind === 'local-docker')) return {};
  return { [kind]: createRunner(kind, opts) };
}

function createRunner(
  kind: RunnerKind,
  opts: {
    workDir: string;
    config?: Record<string, unknown>;
    sandbox?: VercelSandboxOptions;
    fetch?: typeof fetch;
  },
): Runner {
  const config = opts.config ?? {};
  if (kind === 'local') return new LocalRunner(opts.workDir);
  if (kind === 'local-docker') return new DockerRunner(config as DockerOptions);
  if (kind === 'vercel-sandbox') return new VercelSandboxRunner({ ...opts.sandbox, ...config });
  if (kind === 'github-actions')
    return new GithubActionsRunner({ ...config, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  if (typeof config.url !== 'string' || typeof config.secret !== 'string')
    throw new Error('HTTP runner requires a URL and secret');
  return new HttpRunner({
    url: config.url,
    secret: config.secret,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

export function visibleRunner(record: RunnerRecord, requester?: string): boolean {
  return record.scope === 'workspace' || Boolean(requester && record.owner === requester);
}

export function serverRunnerId(ctx: ServerContext): string {
  return ctx.local ? 'local' : 'default';
}

export async function chooseRunner(
  ctx: ServerContext,
  options: { requester?: string; runner?: string; agent?: string } = {},
): Promise<{ runner: RunnerKind; runnerId?: string }> {
  const named = options.runner ?? options.agent;
  if (named === serverRunnerId(ctx)) return { runner: ctx.config.runner };
  const rows = (
    await ctx.store.list('runner', {
      visibleTo: options.requester,
      ...(named ? { runner: named } : { defaults: true }),
    })
  ).filter(
    ({ value }) =>
      visibleRunner(value, options.requester) &&
      (ctx.local || (value.kind !== 'local' && value.kind !== 'local-docker')),
  );
  const found = named
    ? rows.find(({ id, value }) => id === named || value.name === named)
    : (rows.find(({ value }) => value.scope === 'personal' && value.default) ??
      rows.find(({ value }) => value.scope === 'workspace' && value.default));
  if (named && !found) throw new Error(`Unknown runner "${named}".`);

  return found ? { runner: found.value.kind, runnerId: found.id } : { runner: ctx.config.runner };
}

export function recordRunner(ctx: ServerContext, record: RunnerRecord, id?: string): Runner {
  const config = {
    ...record.config,
    ...decryptSecret<Record<string, string>>(ctx.config, record.secret),
  };
  return createRunner(record.kind, {
    workDir: ctx.config.workDir,
    config,
    fetch: ctx.fetch,
    sandbox: {
      ...(id
        ? {
            snapshots: runnerSnapshots(ctx.store, `runner:${id}:`),
          }
        : {}),
    },
  });
}

export async function taskRunner(
  ctx: ServerContext,
  task: Pick<AgentTask, 'runner' | 'runnerId'>,
): Promise<Runner | undefined> {
  if (!task.runnerId) return ctx.runners[task.runner];

  const record = await ctx.store.get('runner', task.runnerId);
  if (
    !record ||
    record.kind !== task.runner ||
    (!ctx.local && (record.kind === 'local' || record.kind === 'local-docker'))
  ) {
    ctx.settings?.runnerInstances?.delete(task.runnerId);
    return undefined;
  }

  decryptSecret(ctx.config, record.secret);

  const instances = ((ctx.settings ??= {}).runnerInstances ??= new Map());
  const signature = JSON.stringify([record.kind, record.config, record.secret]);
  let instance = instances.get(task.runnerId);
  if (instance?.signature !== signature) {
    instance = { signature, runner: recordRunner(ctx, record, task.runnerId) };
    instances.set(task.runnerId, instance);
  }

  return instance!.runner;
}

export function validateRunnerConfig(spec: RunnerSpec, config: Record<string, string>): void {
  if (Object.keys(config).some(key => !spec.fields.some(field => field.key === key)))
    throw new Error('Unknown runner field');
  for (const field of spec.fields)
    if (!field.optional && !config[field.key]?.trim())
      throw new Error(`${field.label} is required`);
  if (spec.kind === 'http') {
    if (config.secret!.length < 32) throw new Error('Secret must contain at least 32 characters');
    new HttpRunner({ url: config.url!, secret: config.secret! });
  }
  if (spec.kind === 'github-actions' && !/^[\w.-]+\/[\w.-]+$/.test(config.repo!))
    throw new Error('Repository must be owner/repo');
  if (
    spec.kind === 'local-docker' &&
    config.cpus &&
    !(Number(config.cpus) > 0 && Number.isFinite(Number(config.cpus)))
  )
    throw new Error('CPUs must be positive');
}

class RunnerCheckError extends Error {}

export async function testRunner(ctx: ServerContext, record?: RunnerRecord): Promise<RunnerTest> {
  const start = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new RunnerCheckError('Runner check timed out'));
    }, ctx.runnerTimeoutMs ?? 5000);
  });
  try {
    const detail = await Promise.race([
      timeout,
      (async () => {
        const kind = record?.kind ?? ctx.config.runner;
        const config = record
          ? {
              ...record.config,
              ...decryptSecret<Record<string, string>>(ctx.config, record.secret),
            }
          : (ctx.config.runnerConfig ?? {});
        if (kind === 'local') {
          if (!ctx.local) throw new RunnerCheckError('Local runners require a local server');
          return 'This machine is available';
        }
        if (kind === 'http') {
          const runner = record ? recordRunner(ctx, record) : ctx.runners.http;
          if (!(runner instanceof HttpRunner) || !(await runner.health(controller.signal)).ok)
            throw new RunnerCheckError('Runner health check failed');
          return 'Runner is reachable';
        }
        if (kind === 'local-docker') {
          if (!ctx.local) throw new RunnerCheckError('Docker runners require a local server');
          await new Promise<void>((resolve, reject) => {
            (ctx.runnerExec ?? execFile)(
              'docker',
              ['info'],
              { timeout: 5000, signal: controller.signal },
              error => (error ? reject(new RunnerCheckError('Docker is unavailable')) : resolve()),
            );
          });
          return 'Docker is available';
        }
        const request = async (url: string) => {
          const response = await (ctx.fetch ?? fetch)(url, {
            signal: controller.signal,
            redirect: 'manual',
            headers: {
              authorization: `Bearer ${config.token}`,
              accept: 'application/json',
              'user-agent': 'coder',
            },
          });
          if (!response.ok)
            throw new RunnerCheckError(`Runner check failed with HTTP ${response.status}`);
          return response;
        };
        if (kind === 'github-actions') {
          const repo = String(config.repo).split('/').map(encodeURIComponent).join('/');
          await request(`https://api.github.com/repos/${repo}`);
          await request(
            `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(String(config.workflow))}`,
          );
          return 'Repository and workflow are accessible';
        }
        const response = await request('https://api.vercel.com/v2/teams?limit=100');
        const body = (await response.json()) as {
          teams?: Array<{ id: string; slug?: string }>;
          pagination?: { next?: number };
        };
        if (!Array.isArray(body.teams)) throw new RunnerCheckError('Invalid team response');
        if (
          config.team &&
          !body.teams.some(team => team.id === config.team || team.slug === config.team)
        )
          throw new RunnerCheckError('Team is not accessible');
        return 'Teams are accessible';
      })(),
    ]);
    return { ok: true, detail, ms: Date.now() - start };
  } catch (error) {
    const detail = error instanceof RunnerCheckError ? error.message : 'Runner check failed';
    return { ok: false, detail, ms: Date.now() - start };
  } finally {
    clearTimeout(timer!);
  }
}

export interface RunnerStatus {
  state: 'running' | 'exited';
  code?: number;
}

export interface Runner {
  readonly kind: RunnerKind;
  /** `credential` is the engine credential's env, for runners that broker it outside the task. */
  start(
    task: AgentTask,
    env: Record<string, string>,
    credential?: Record<string, string>,
    /** `timeoutMs`: how long its machine may live, where the runner starts one. */
    options?: {
      timeoutMs?: number;
      waitUntil?: (work: Promise<unknown>) => void;
      /** The only hosts a firewalled machine reaches besides its start; absent allows all. */
      hosts?: string[];
    },
  ): Promise<string>;
  status(handle: string): Promise<RunnerStatus>;
  stop(handle: string): Promise<void>;
  push?(handle: string, entries: InboxEntry[]): Promise<InboxAck>;
}
