/** Runner kinds live in kinds/, one file or folder each; this folder's root holds only what they share: this catalog, select.ts and package.ts. */
import type { AgentTask, RunnerKind } from '../../agent/types';
import type { InboxEntry, InboxAck } from '../tasks/queue';
import type { ServerConfig } from '../context';
import { DockerRunner, type DockerOptions } from './kinds/docker';
import { GithubActionsRunner } from './kinds/github-actions';
import { HttpRunner } from './kinds/http';
import { LocalRunner } from './kinds/local';
import {
  VercelSandboxRunner,
  type BrokerRule,
  type VercelSandboxOptions,
} from './kinds/vercel-sandbox';

export const RUNNER_KINDS: RunnerKind[] = [
  'local',
  'local-docker',
  'vercel-sandbox',
  'github-actions',
  'http',
];

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

export function createRunner(
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

/** The vCPUs a task on the server's own runner holds: `vcpus` of a vercel-sandbox config, else 1. */
export function serverVcpus(config: Pick<ServerConfig, 'runner' | 'runnerConfig'>): number {
  const vcpus = config.runner === 'vercel-sandbox' ? config.runnerConfig?.vcpus : undefined;

  return typeof vcpus === 'number' && Number.isInteger(vcpus) && vcpus > 0 ? vcpus : 1;
}

/** A failed runner check whose message the settings page shows. */
export class RunnerCheckError extends Error {}

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
      /** Variables of `credential` the machine's firewall injects by host, so their values never enter it. */
      brokered?: BrokerRule[];
      /** A one-time code the machine trades at the server for `env.CODER_TASK_TOKEN`, for transports whose start others read. */
      claim?: () => Promise<string>;
    },
  ): Promise<string>;
  /** Whether `token` proves its holder is the machine `handle` started, for transports whose start others read. */
  verifyJob?(handle: string, token: string, audience: string): Promise<boolean>;
  status(handle: string): Promise<RunnerStatus>;
  stop(handle: string): Promise<void>;
  push?(handle: string, entries: InboxEntry[]): Promise<InboxAck>;
  /** Delete a deleted task's work folder on runners that keep one across turns. */
  remove?(taskId: string, handle?: string): Promise<void>;
  /** Archives the task's engine threads on this machine. */
  archive?(taskId: string): Promise<void>;
}
