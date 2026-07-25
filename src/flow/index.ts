/** `@wular/coder/flow` authoring surface. See docs/flows.md for the contract. */
import {
  archiveRun,
  collectFlowRuns,
  currentScopeArgs,
  deleteRun,
  flowSteps,
  listRuns,
  readFlowRecord,
  resumeFlow,
  runFlow,
  stopRun,
  streamFlowCore,
} from './runtime.js';
import { CoderError } from '../lib/dispatch.js';
import { discoverFlows } from './discover.js';
import type { DiscoveredFlow, FlowEvent, FlowRecord, FlowStep } from './types.js';
import type { RunOptions, RunSummary, StopSummary } from './runtime.js';

export { task, gate, pipeline, log, flow } from './runtime.js';
export { CoderError } from '../lib/dispatch.js';
export type { FlowEvent, FlowStep, FlowTaskResult, GateResult, FlowTaskOptions } from './types.js';

/**
 * The flow's `--args` value. A Proxy over the ALS-bound current args, so a
 * top-level `import { args }` reflects whichever run is executing.
 */
export const args: Record<string, unknown> = new Proxy(
  {},
  {
    get(_t, prop) {
      const a = currentScopeArgs();
      return a == null ? undefined : (a as any)[prop];
    },
    has(_t, prop) {
      const a = currentScopeArgs();
      return a != null && prop in Object(a);
    },
    ownKeys() {
      const a = currentScopeArgs();
      return a ? Reflect.ownKeys(Object(a)) : [];
    },
    getOwnPropertyDescriptor(_t, prop) {
      const a = currentScopeArgs();
      if (a != null && prop in Object(a)) {
        return { enumerable: true, configurable: true, value: (a as any)[prop] };
      }
      return undefined;
    },
  },
);

// Archive/delete act on terminal runs only; a running run must be stopped first.
function requireStoppedRun(runId: string) {
  const record = readFlowRecord(runId);
  if (!record) {
    throw new CoderError('flow-failed', `No flow run "${runId}".`, {
      hint: 'Recent runs: coder flow list',
    });
  }
  if (record.status === 'running' || record.status === 'queued') {
    throw new CoderError('flow-failed', `Run ${record.runId} is still running.`, {
      runId: record.runId,
      hint: `Stop it first: coder flow stop ${record.runId}`,
    });
  }
  return record;
}

/** Run and inspect flows programmatically; mirrors `coder flow`. */
export const flowSdk = {
  /** Run a flow and await its result. */
  run(nameOrPath: string, opts: RunOptions = {}): Promise<RunSummary> {
    return runFlow(nameOrPath, opts);
  },
  /** Recent flow runs (mirrors `coder flow list`). */
  list(opts: { archived?: boolean; limit?: number } = {}): FlowRecord[] {
    return collectFlowRuns(opts).runs;
  },
  /** Flows discoverable from a directory (workspace + global). */
  discover(cwd?: string): DiscoveredFlow[] {
    return discoverFlows(cwd ?? process.cwd());
  },
  /** A run's record plus its step rows (omit the id for the most recent run). `tail` caps steps (default 'all'; 0 → []). */
  result(
    runId?: string,
    opts: { tail?: number | 'all' } = {},
  ): (FlowRecord & { steps: FlowStep[] }) | null {
    const record = runId ? readFlowRecord(runId) : (listRuns()[0] ?? null);
    return record ? { ...record, steps: flowSteps(record.runId, opts.tail) } : null;
  },
  /** Follow a run live: an async iterable of flow events, ending when the run is terminal. `tail` replays only the last n (default 'all'). */
  stream(runId?: string, opts: { tail?: number | 'all' } = {}): AsyncGenerator<FlowEvent> {
    const id = runId ?? listRuns()[0]?.runId;
    if (!id) throw new Error('No flow runs to stream.');
    return streamFlowCore(id, undefined, { tail: opts.tail });
  },
  /** Stop a running flow (and, by default, its still-running tasks). */
  stop(runId?: string, opts: { keepTasks?: boolean } = {}): Promise<StopSummary> {
    return stopRun(runId, opts);
  },
  /** Continue a stopped or edited run from its journal and await the result. */
  resume(runId?: string, opts: RunOptions = {}): Promise<RunSummary> {
    const id = runId ?? listRuns()[0]?.runId;
    if (!id) throw new Error('No flow runs to resume.');
    return resumeFlow(id, opts);
  },
  /** Archive a run (hide it from the default list). A running run must be stopped first. */
  archive(runId: string): { runId: string; archived: true } {
    archiveRun(requireStoppedRun(runId));
    return { runId, archived: true };
  },
  /** Delete a run's record from disk (its tasks are left alone). A running run must be stopped first. */
  delete(runId: string): { runId: string; deleted: boolean } {
    requireStoppedRun(runId);
    return { runId, deleted: deleteRun(runId) };
  },
};

export default flowSdk;
