/** `@wular/coder/flow` authoring surface. See docs/flows.md for the contract. */
import { currentScopeArgs } from './runtime';
import { stopRun } from './executor';
import { collectFlowRuns } from './runs';
import { discoverFlows } from './discover';
import {
  archiveRuns,
  deleteRuns,
  resumeRun,
  runResult,
  startRun,
  watchRun,
  type RunResult,
} from './runs';
import type { DiscoveredFlow, FlowEvent, FlowRecord } from './types';
import type { RunOptions, RunSummary, StopSummary } from './executor';

export { task, gate, pipeline, log, flow } from './runtime';
export { CoderError } from '../core/dispatch';
export type { FlowEvent, FlowStep, FlowTaskResult, GateResult, FlowTaskOptions } from './types';

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

/** Run and inspect flows programmatically; mirrors `coder flow`. */
export const flowSdk = {
  /** Run a flow and await its result. */
  run(nameOrPath: string, opts: RunOptions = {}): Promise<RunSummary> {
    return startRun(nameOrPath, opts) as Promise<RunSummary>;
  },
  /** Recent flow runs (mirrors `coder flow list`). */
  list(opts: { archived?: boolean; limit?: number | 'all' } = {}): FlowRecord[] {
    return collectFlowRuns(opts).runs;
  },
  /** Flows discoverable from a directory (workspace + global). */
  discover(cwd?: string): DiscoveredFlow[] {
    return discoverFlows(cwd ?? process.cwd());
  },
  /** A run's record with its step rows, journal and events (omit the id for the most recent run). `tail` caps steps (default 'all'; 0 → []). */
  result(runId?: string, opts: { tail?: number | 'all' } = {}): RunResult | null {
    return runResult(runId, opts);
  },
  /** Follow a run live: an async iterable of flow events, ending when the run is terminal. `tail` replays only the last n (default 'all'). */
  stream(runId?: string, opts: { tail?: number | 'all' } = {}): AsyncGenerator<FlowEvent> {
    return watchRun(runId, opts).events;
  },
  /** Stop a running flow (and, by default, its still-running tasks). */
  stop(runId?: string, opts: { keepTasks?: boolean } = {}): Promise<StopSummary> {
    return stopRun(runId, opts);
  },
  /** Continue a stopped or edited run from its journal and await the result. */
  resume(runId?: string, opts: RunOptions = {}): Promise<RunSummary> {
    return resumeRun(runId, opts) as Promise<RunSummary>;
  },
  /** Archive a run (hide it from the default list), or with `allStopped` every stopped one. A running run must be stopped first. */
  archive: archiveRuns,
  /** Delete a run's record from disk (its tasks are left alone), or with `allArchived` every archived one. A running run must be stopped first. */
  delete: deleteRuns,
};

export default flowSdk;
