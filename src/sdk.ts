/** `@wular/coder` public SDK. See docs/sdk.md for the contract. */
import path from 'node:path';
import process from 'node:process';

import {
  archiveJob,
  deleteJob,
  findJob,
  resolveJobDir,
  type JobLogEntry,
} from './lib/state.js';
import { answerApproval, listPendingApprovals } from './lib/approvals.js';
import {
  CoderError,
  dispatchTask,
  readTask,
  waitTask,
  type TaskResult,
} from './lib/dispatch.js';
import { collectJobs, type ListOptions } from './cmd/jobs.js';
import { stopTaskCore } from './cmd/stop.js';
import { deleteSessionFor } from './cmd/delete.js';
import { steerTaskCore, type SteerOutcome } from './cmd/steer.js';
import { streamTaskCore } from './cmd/stream.js';
import {
  modelAddCore,
  modelAliasCore,
  modelListData,
  modelRemoveCore,
  modelToggleCore,
  modelUnaliasCore,
  modelUpdateCore,
  type ModelWriteOptions,
} from './cmd/model.js';
import { configGet, configSet } from './cmd/config.js';
import { setupHostCore } from './cmd/setup-host.js';
import { upgradeCore } from './cmd/upgrade.js';
import { docsCore } from './cmd/docs.js';
import { flowSdk as flow } from './flow/index.js';
import type { FlowEvent, FlowStep } from './flow/types.js';
import type { Approval, Job, TurnResult } from './lib/types.js';

function resolveCwd(cwd?: string): string {
  return cwd ? path.resolve(cwd) : process.cwd();
}

function mustFindJob(cwd: string, reference?: string): Job {
  const job = findJob(cwd, reference);
  if (!job) {
    throw new Error(
      reference ? `No task found for "${reference}".` : 'No tasks found for this workspace.',
    );
  }
  return job;
}

// ---------------------------------------------------------------------------
// task
// ---------------------------------------------------------------------------

export interface TaskRunOptions {
  agent?: string;
  model?: string;
  effort?: string;
  permissions?: string;
  name?: string;
  system?: string;
  resume?: string;
  cwd?: string;
}

/** Run and control coder tasks. Mirrors `coder task`. */
export const task = {
  /** Dispatch a task to the agent chain; returns as soon as it is live. */
  async run(prompt: string, opts: TaskRunOptions = {}): Promise<{ taskId: string }> {
    const { taskId } = await dispatchTask({
      prompt,
      cwd: resolveCwd(opts.cwd),
      agent: opts.agent,
      model: opts.model,
      effort: opts.effort,
      permissions: opts.permissions,
      name: opts.name,
      system: opts.system,
      resume: opts.resume,
    });
    return { taskId };
  },

  /**
   * A task's result. With `wait`, blocks until the task is terminal (a pending
   * approval throws a CoderError with code 'approval-pending'). `tail` fills
   * `steps` with the last n log entries (default 0: []). Omit the id for the
   * most recent task.
   */
  async result(
    id?: string,
    opts: { wait?: boolean; tail?: number | 'all'; cwd?: string } = {},
  ): Promise<TaskResult> {
    const cwd = resolveCwd(opts.cwd);
    const taskId = id ?? mustFindJob(cwd).id;
    return opts.wait
      ? waitTask(cwd, taskId, { tail: opts.tail })
      : readTask(cwd, taskId, { tail: opts.tail });
  },

  /** Recent tasks (mirrors `coder list` / `coder task list`). */
  list(opts: ListOptions & { cwd?: string } = {}): Job[] {
    return collectJobs(resolveCwd(opts.cwd), opts).jobs;
  },

  /** Steer a follow-up into a task (live, queued, or resumed on its thread). */
  async steer(
    id: string,
    text: string,
    opts: { cwd?: string } = {},
  ): Promise<{ taskId: string; steered: SteerOutcome }> {
    const cwd = resolveCwd(opts.cwd);
    return steerTaskCore(cwd, mustFindJob(cwd, id), text);
  },

  /** Stop a running task. */
  async stop(
    id: string,
    opts: { cwd?: string } = {},
  ): Promise<{ taskId: string; status: 'cancelled'; interrupt: string }> {
    const cwd = resolveCwd(opts.cwd);
    return stopTaskCore(cwd, mustFindJob(cwd, id));
  },

  /** Archive a task (hide it from the default list). */
  archive(id: string, opts: { cwd?: string } = {}): { taskId: string; archived: true } {
    const cwd = resolveCwd(opts.cwd);
    archiveJob(cwd, mustFindJob(cwd, id));
    return { taskId: id, archived: true };
  },

  /** Delete a task and its engine session from disk. */
  delete(id: string, opts: { cwd?: string } = {}): { taskId: string; deleted: boolean } {
    const cwd = resolveCwd(opts.cwd);
    const job = mustFindJob(cwd, id);
    if (job.status === 'running') {
      throw new Error(`Task ${job.id} is still running.`);
    }
    deleteSessionFor(job);
    const deleted = deleteJob(cwd, job.id);
    return { taskId: job.id, deleted };
  },

  /** Answer a pending approval (accept, or `deny`). */
  approve(
    id: string,
    approvalId: string,
    opts: { deny?: boolean; cwd?: string } = {},
  ): { taskId: string; approvalId: string; decision: 'accept' | 'decline' } {
    const cwd = resolveCwd(opts.cwd);
    const job = mustFindJob(cwd, id);
    const decision = opts.deny ? 'decline' : 'accept';
    answerApproval(resolveJobDir(cwd, job.id), approvalId, decision);
    return { taskId: job.id, approvalId, decision };
  },

  /** Pending approvals for a task (omit the id for the most recent task). */
  approvals(id?: string, opts: { cwd?: string } = {}): Approval[] {
    const cwd = resolveCwd(opts.cwd);
    const job = id ? mustFindJob(cwd, id) : mustFindJob(cwd);
    return listPendingApprovals(resolveJobDir(cwd, job.id));
  },

  /** Follow a task live: an async iterable of progress log entries. `tail` replays only the last n (default 1). */
  stream(
    id?: string,
    opts: { tail?: number | 'all'; cwd?: string } = {},
  ): AsyncGenerator<JobLogEntry> {
    const cwd = resolveCwd(opts.cwd);
    return streamTaskCore(cwd, id ?? mustFindJob(cwd).id, { tail: opts.tail });
  },
};

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------

/** Manage models: custom endpoints, engine aliases, disable toggles. Mirrors `coder model`. */
export const model = {
  /** Register a custom OpenAI-compatible endpoint model. */
  add: (name: string, opts: ModelWriteOptions & { cwd?: string }) =>
    modelAddCore(resolveCwd(opts.cwd), name, opts),
  /** Update fields of a configured model entry. */
  update: (name: string, opts: ModelWriteOptions & { cwd?: string }) =>
    modelUpdateCore(resolveCwd(opts.cwd), name, opts),
  /** Remove a configured model entry. */
  remove: (name: string, opts: { workspace?: boolean; cwd?: string } = {}) =>
    modelRemoveCore(resolveCwd(opts.cwd), name, opts),
  /** Every dispatchable model: built-ins, aliases, custom endpoints. */
  list: (opts: { cwd?: string } = {}) => modelListData(resolveCwd(opts.cwd)),
  /** Alias a name to an engine spec, e.g. alias('fast', 'codex:spark'). */
  alias: (name: string, spec: string, opts: { workspace?: boolean; cwd?: string } = {}) =>
    modelAliasCore(resolveCwd(opts.cwd), name, spec, opts),
  /** Remove a user-defined alias. */
  unalias: (name: string, opts: { workspace?: boolean; cwd?: string } = {}) =>
    modelUnaliasCore(resolveCwd(opts.cwd), name, opts),
  /** Disable a model name (built-in, alias, or raw slug) without removing it. */
  disable: (name: string, opts: { workspace?: boolean; cwd?: string } = {}) =>
    modelToggleCore(resolveCwd(opts.cwd), name, true, opts),
  /** Re-enable a disabled model name. */
  enable: (name: string, opts: { workspace?: boolean; cwd?: string } = {}) =>
    modelToggleCore(resolveCwd(opts.cwd), name, false, opts),
};

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/** Read and write coder configuration. Mirrors `coder config`. */
export const config = {
  /** A config value by dotted key (or the whole effective config). */
  get: (key?: string, opts: { cwd?: string } = {}) => configGet(resolveCwd(opts.cwd), key),
  /** Set a config value; `workspace` targets the repo file instead of the user file. */
  set: (
    key: string,
    value: unknown,
    opts: { workspace?: boolean; cwd?: string } = {},
  ) => configSet(resolveCwd(opts.cwd), key, value, opts),
};

// ---------------------------------------------------------------------------
// host
// ---------------------------------------------------------------------------

/** Probe engines, seed the chain, install requested host plugins. */
export function setupHost(
  hosts: string[] = [],
  opts: { cwd?: string } = {},
) {
  return setupHostCore(resolveCwd(opts.cwd), {
    claude: hosts.includes('claude'),
    codex: hosts.includes('codex'),
    agents: hosts.includes('agents'),
  });
}

/** Update the CLI and/or host plugin installs; returns what moved. */
export function upgrade(
  opts: { cliOnly?: boolean; pluginsOnly?: boolean } = {},
) {
  return upgradeCore(opts);
}

/** List bundled docs, or return one topic's raw markdown. */
export function docs(topic?: string) {
  return docsCore(topic);
}

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------

export {
  CoderError,
};
export type { Approval, FlowEvent, FlowStep, Job, JobLogEntry, TaskResult, TurnResult, SteerOutcome };

export { flow };
export default { task, flow, model, config, setupHost, upgrade, docs };
