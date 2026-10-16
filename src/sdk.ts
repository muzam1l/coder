/** `@wular/coder` public SDK. See docs/sdk.md for the contract. */
import { agents } from './agent';
import { sessions } from './client/auth/sign-in';
import type { Session } from './client/auth/session';
import { credentials, connect, type ServerOptions } from './core/remote';
import { config } from './core/config';
import { connection as connections } from './core/connection';
import { CoderError, type TaskResult } from './core/dispatch';
import { docsCore } from './core/docs';
import { setupHost, upgradeCore } from './core/hosts';
import { models as model } from './core/models';
import type { TaskLogEntry } from './core/state';
import { tasks, type TaskRunOptions } from './core/task';
import type { SteerOutcome } from './core/task/actions';
import type { Approval, Task, TurnResult } from './core/types';
import type { ReviewArgs, ReviewResult } from './flow/builtin/review';
import { flowSdk as flow } from './flow';
import { review } from './flow/executor';
import type { FlowEvent, FlowStep } from './flow/types';
import { runners as runner } from './runner';
import { serverAppLink } from './server/agents/apps';
import { rotateKey } from './server/maintenance';
import { actionsWorkflow } from './server/runners/github-actions';
import { serve, serverHandler } from './server/serve';

/** Run and control coder tasks. Mirrors `coder task`. */
export const task = tasks;

/** Manage models: custom endpoints, engine aliases, disable toggles. Mirrors `coder model`. */
export { models as model } from './core/models';

/** Read and write coder configuration. Mirrors `coder config`. */
export { config } from './core/config';

/** Platform accounts, API keys and MCP servers tasks use, on this machine or a Coder server. Mirrors `coder connection`. */
export const connection = connections;

/** Probe engines, seed the chain, install requested host plugins. */
export { setupHost } from './core/hosts';

/** Update the CLI and/or host plugin installs; returns what moved. */
export const upgrade = upgradeCore;

/** List bundled docs, or return one topic's raw markdown; `claude` picks the Claude Code flavor of the skill. */
export const docs = docsCore;

/** Run the built-in read-only code-review flow. */
export { review } from './flow/executor';

/** Sign in and manage saved sessions. Mirrors `coder auth`. */
export const auth = sessions;

/** Run and host a Coder server. Mirrors `coder server`. */
export const server = {
  serve,
  rotateKey,
  /** The GitHub Actions workflow the `github-actions` runner dispatches. */
  workflow: actionsWorkflow,
  app: {
    /** A link, valid 10 minutes, to the page that creates the built-in agent's public app on a platform. */
    create: serverAppLink,
  },
  handler: serverHandler,
};

/** Engine credentials on a Coder server. Mirrors `coder credentials`. */
export { credentials } from './core/remote';

export const folders = {
  list: (options: ServerOptions = {}) => connect(options).folders.list(),
  check: (path: string, options: ServerOptions = {}) => connect(options).folders.check(path),
};

/** Your own runners for a Coder server. Mirrors `coder runner`. */
export { runners as runner } from './runner';

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
export type { LocalFolder, LocalFolders, ConnectionRow } from './client/types';
export type { ConnectionAddOptions, ConnectionOptions, DeclaredServer } from './core/connection';
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
  connection,
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
