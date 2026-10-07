/** `@wular/coder` public SDK. See docs/sdk.md for the contract. */
import path from 'node:path';
import process from 'node:process';

import { agents } from './agent';
import { sessions } from './client/auth/sign-in';
import type { Session } from './client/auth/session';
import { addCredential, loginCredential, connect, type ServerOptions } from './core/remote';
import {
  configGet,
  configSet,
  mcpAdd,
  mcpAddJson,
  mcpList,
  mcpRemove,
  type McpAddOptions,
} from './core/config';
import { CoderError, type TaskResult } from './core/dispatch';
import { docsCore } from './core/docs';
import { setupHostCore, upgradeCore } from './core/hosts';
import {
  modelAddCore,
  modelAliasCore,
  modelListData,
  modelRemoveCore,
  modelToggleCore,
  modelUnaliasCore,
  modelUpdateCore,
  type ModelWriteOptions,
} from './core/models';
import type { TaskLogEntry } from './core/state';
import { tasks, type TaskRunOptions } from './core/task';
import type { SteerOutcome } from './core/task/actions';
import type { Approval, Task, TurnResult } from './core/types';
import type { ReviewArgs, ReviewResult } from './flow/builtin/review';
import { flowSdk as flow } from './flow';
import { runFlowByName } from './flow/executor';
import type { FlowEvent, FlowStep } from './flow/types';
import {
  listRunners,
  addRunner,
  pairRunner,
  updateRunner,
  testRunner,
  removeRunner,
} from './runner';
import { serveRunner } from './runner/serve';
import { serverAppLink } from './server/agents/apps';
import { migrate, rotateKey } from './server/maintenance';
import { ACTIONS_WORKFLOW_YAML } from './server/runners/github-actions';
import { serve, serverHandler } from './server/serve';

function resolveCwd(cwd?: string): string {
  return cwd ? path.resolve(cwd) : process.cwd();
}

/** Run and control coder tasks. Mirrors `coder task`. */
export const task = tasks;

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
  /** Alias a name to an engine spec, e.g. alias('fast', 'codex:luna'). */
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

/** Read and write coder configuration. Mirrors `coder config`. */
export const config = {
  /** A config value by dotted key (or the whole effective config). */
  get: (key?: string, opts: { cwd?: string } = {}) => configGet(resolveCwd(opts.cwd), key),
  /** Set a config value; `workspace` targets the repo file instead of the user file. */
  set: (key: string, value: unknown, opts: { workspace?: boolean; cwd?: string } = {}) =>
    configSet(resolveCwd(opts.cwd), key, value, opts),
};

/** Configure MCP servers in `.coder/config.json`, or the user file with `user`. Mirrors `coder mcp`. */
export const mcp = {
  /** Save a stdio (`command`) or remote (`url`) server; `env`, `header` and `tools` are comma lists. */
  add: (name: string, opts: McpAddOptions & { cwd?: string }) =>
    mcpAdd(resolveCwd(opts.cwd), name, opts),
  /** Save an entry from any `.mcp.json`, as an object or JSON text. */
  addJson: (
    name: string,
    entry: string | Record<string, unknown>,
    opts: { user?: boolean; cwd?: string } = {},
  ) => mcpAddJson(resolveCwd(opts.cwd), name, entry, opts),
  /** The configured servers by name. */
  list: (opts: { cwd?: string } = {}) => mcpList(resolveCwd(opts.cwd)),
  /** Remove a server. */
  remove: (name: string, opts: { user?: boolean; cwd?: string } = {}) =>
    mcpRemove(resolveCwd(opts.cwd), name, opts),
};

/** Probe engines, seed the chain, install requested host plugins. */
export function setupHost(hosts: string[] = [], opts: { cwd?: string } = {}) {
  return setupHostCore(resolveCwd(opts.cwd), { hosts });
}

/** Update the CLI and/or host plugin installs; returns what moved. */
export function upgrade(opts: { cliOnly?: boolean; pluginsOnly?: boolean } = {}) {
  return upgradeCore(opts);
}

/** List bundled docs, or return one topic's raw markdown; `claude` picks the Claude Code flavor of the skill. */
export function docs(topic?: string, opts: { claude?: boolean } = {}) {
  return docsCore(topic, opts);
}

/** Run the built-in read-only code-review flow. */
export const review = {
  async run(options: ReviewArgs = {}): Promise<ReviewResult & { runId: string }> {
    const run = await runFlowByName('review', { cwd: options.cwd, args: options });
    return { ...(run.result as ReviewResult), runId: run.runId };
  },
};

/** Sign in and manage saved sessions. Mirrors `coder auth`. */
export const auth = sessions;

/** Run and host a Coder server. Mirrors `coder server`. */
export const server = {
  serve,
  migrate,
  rotateKey,
  /** The GitHub Actions workflow the `github-actions` runner dispatches. */
  workflow: () => ACTIONS_WORKFLOW_YAML,
  app: {
    /** A link, valid 10 minutes, to the page that creates the built-in agent's public app on a platform. */
    create: serverAppLink,
  },
  handler: serverHandler,
};

/** Engine credentials on a Coder server. Mirrors `coder credentials`. */
export const credentials = {
  list: (options: ServerOptions = {}) => connect(options).credentials.list(),
  add: addCredential,
  remove: (label: string, options: ServerOptions & { workspace?: boolean } = {}) =>
    connect(options).credentials.remove(label, options),
  default: (label: string, options: ServerOptions & { workspace?: boolean } = {}) =>
    connect(options).credentials.setDefault(label, options),
  login: loginCredential,
};

export const folders = {
  list: (options: ServerOptions = {}) => connect(options).folders.list(),
  check: (path: string, options: ServerOptions = {}) => connect(options).folders.check(path),
};

/** Your own runners for a Coder server. Mirrors `coder runner`. */
export const runner = {
  list: listRunners,
  add: addRunner,
  pair: pairRunner,
  update: updateRunner,
  default: (id: string, options: ServerOptions = {}) =>
    updateRunner(id, { default: true }, options),
  test: testRunner,
  rename: (id: string, name: string, options: ServerOptions = {}) =>
    updateRunner(id, { name }, options),
  remove: removeRunner,
  serve: serveRunner,
};

/** Manage and run agents. Each function mirrors one `coder agent` command. */
export const agent = agents;

export { CoderError };
export type {
  Approval,
  ServerOptions,
  TaskRunOptions,
  FlowEvent,
  FlowStep,
  Task,
  TaskLogEntry,
  TaskResult,
  TurnResult,
  SteerOutcome,
};
export type { ReviewResult, ReviewArgs };
export type { Session };
export type { LocalFolder, LocalFolders } from './client/types';
export type {
  RunnerKind,
  RunnerSpec,
  RunnerRow,
  RunnerPairing,
  RunnerInput,
  RunnerUpdate,
  RunnerTest,
} from './client/types';

export { flow };
export default {
  task,
  flow,
  model,
  config,
  mcp,
  setupHost,
  upgrade,
  docs,
  review,
  auth,
  agent,
  credentials,
  folders,
  runner,
  server,
};
