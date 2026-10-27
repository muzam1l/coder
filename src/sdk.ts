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
import { requireBunServer } from './server/env';
import { actionsWorkflow } from './server/runners/kinds/github-actions';
import type { serve as Serve, serverHandler as ServerHandler } from './server/serve';
import type { rotateKey as RotateKey } from './server/maintenance';
import type { serverAppLink as ServerAppLink } from './server/agents/apps';

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

/** The serverless request handler; the server code loads with its first call. */
function serverHandler(
  ...args: Parameters<typeof ServerHandler>
): ReturnType<typeof ServerHandler> {
  requireBunServer();
  const handler = import('./server/serve').then(({ serverHandler }) => serverHandler(...args));

  return Object.assign(
    async (request: Request, waitUntil?: (work: Promise<unknown>) => void) =>
      (await handler)(request, waitUntil),
    {
      scheduled: async () => (await handler).scheduled(),
      close: async () => (await handler).close(),
    },
  );
}

/** Run and host a Coder server. Mirrors `coder server`. */
export const server = {
  serve: async (...args: Parameters<typeof Serve>) =>
    (await import('./server/serve')).serve(...args),
  rotateKey: async (...args: Parameters<typeof RotateKey>) =>
    (await import('./server/maintenance')).rotateKey(...args),
  /** The GitHub Actions workflow the `github-actions` runner dispatches. */
  workflow: actionsWorkflow,
  app: {
    /** A link, valid 10 minutes, to the page that creates the built-in agent's public app on a platform. */
    create: async (...args: Parameters<typeof ServerAppLink>) =>
      (await import('./server/agents/apps')).serverAppLink(...args),
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
export type { UsageLimits } from './server/tasks/usage';
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
