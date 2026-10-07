import type { SerializedMessage, SerializedThread } from 'chat';

import type { Effort, McpConfigEntry, Permission } from '../core/config';
import type { TaskTurn, RunnerKind } from '../client/types';

export type Preset = 'observe' | 'comment' | 'write';
export const PRESETS: Preset[] = ['observe', 'comment', 'write'];

export type { RunnerKind } from '../client/types';

/** Per-integration wiring in a definition. `triggers` list = default behavior, map = event -> flow. */
/** Event value in a definition map: a flow name, or options. */
export interface AgentEventOptions {
  /** Flow to run; omit for the default agent. */
  flow?: string;
  /** Regex the event text must match (e.g. keywords on Slack `message`). */
  match?: string;
  /** May only narrow the agent's default permission for this event. */
  permissions?: Permission;
  /** `requester`: the task acts with the linked requester's own platform token. */
  actAs?: 'requester';
}

export interface AgentDefinitionIntegration {
  triggers?: string[] | Record<string, string | true | AgentEventOptions>;
  /** Platform tools the agent uses: a preset or an explicit tool list. */
  tools?: Preset | string[];
}

/** What an agent IS: `.coder/agents/<id>/agent.json` beside its system.md. */
export interface AgentDefinition {
  /** Display name used in replies; defaults to the id. */
  name?: string;
  description?: string;
  engine?: string;
  runner?: string;
  model?: string;
  effort?: Effort;
  permissions?: Permission;
  /** MCP servers every task of this agent attaches, in the `.mcp.json` entry shape. */
  mcp?: Record<string, McpConfigEntry>;
  integrations: Record<string, AgentDefinitionIntegration>;
}

/** Per-integration caps in usage: `allowedTools` and `allowedEvents` intersect the definition's. */
export interface AgentUsageIntegration {
  allowedTools?: Preset | string[];
  allowedEvents?: string[];
}

/** How a repo RUNS an agent: one entry under `agents` in .coder/config.json. */
export interface AgentUsage {
  engine?: string;
  model?: string;
  effort?: Effort;
  permissions?: Permission;
  integrations?: Record<string, AgentUsageIntegration>;
}

export interface Agent {
  id: string;
  /** definition.name ?? id. */
  name: string;
  definition: AgentDefinition;
  usage?: AgentUsage;
  /** Absolute folder path when the agent's body is on disk; remote agents have none. */
  dir?: string;
  /** Stored agent body, including system.md, when there is no on-disk folder. */
  files?: Record<string, string>;
  builtin: boolean;
}

/** A platform event, already typed by its integration. */
export interface AgentEvent {
  integration: string;
  /** Catalog name, e.g. `pull_request` or `mention`. */
  type: string;
  /** `AgentApp.id` the webhook was addressed to. */
  appId: string;
  installationId: string;
  deliveryId: string;
  actor: { id: string; login?: string; role?: string; agent?: boolean };
  /** Human text attached to the event: mention body, comment, PR title + body. */
  text: string;
  /** What the platform tells an agent about where the event happened, such as a Linear issue; bounded. */
  promptContext?: string;
  /** The Chat SDK thread and message it happened in, without raw platform payloads; replies go to this thread. */
  chat?: { thread: SerializedThread; message?: SerializedMessage };
  repo?: {
    owner: string;
    name: string;
    cloneUrl: string;
    ref: string;
    defaultBranch: string;
  };
}

/**
 * One platform app = one agent's handle. Created from the dashboard, or once per server for the built-in agent;
 * the receiver routes each webhook to its app by id. Store kind `app`, id `<integration>:<platform app id>`.
 */
export interface AgentApp {
  id: string;
  integration: string;
  /** Agent id this app serves. */
  agent: string;
  /** App handle: GitHub app slug (`@slug`), Slack bot user name. */
  name: string;
  /** `owner/name` of the repo holding `.coder/agents/<agent>/`; absent for built-in agents. */
  agentsRepo?: string;
  /** Only pushes to this configured source branch may re-import the agent. */
  branch?: string;
  /** A server-level app shared by every workspace, made by `coder server app create`. */
  builtin?: boolean;
  /** Encrypted JSON (`encryptSecret`) of `GithubAppCredentials` or `SlackAppCredentials`. */
  credentials: string;
  createdAt: number;
}

/**
 * A token source for one integration, attached to an installation: another installation of the same
 * agent on that platform (linked at install time), or a user OAuth token from the SaaS login.
 */
export type Connection =
  { kind: 'installation'; id: string } | { kind: 'oauth'; token: string; account?: string };

/** Per-installation settings a user sets from the platform (`/setup` in Slack). */
export interface InstallationSettings {
  /** `owner/name` of the repo whose `.coder/` holds this agent's usage and instructions. */
  configRepo?: string;
  model?: string;
  engine?: string;
  effort?: string;
}

/** One install of an app: a GitHub installation or a Slack workspace. Id `<app id>:<platform install id>`. */
export interface Installation {
  id: string;
  app: string;
  integration: string;
  account: { login: string; type?: string };
  /** Secret the platform hands out once (Slack bot token), encrypted at rest. */
  token?: string;
  /** Platform user who installed (Slack user id); used for the welcome DM. */
  installer?: string;
  /** Other integrations this install can act on, keyed by integration id. */
  connections?: Record<string, Connection>;
  settings?: InstallationSettings;
  createdAt: number;
  deletedAt?: number;
}

/** Where a task came from: a Coder surface, or the id of the integration whose event started it. */
export type TaskSource = 'dashboard' | 'cli' | 'schedule' | (string & {});

export interface AgentTask {
  cwd?: string;
  id: string;
  name?: string;
  source: TaskSource;
  agent: string;
  /** Flow name, or `default` for the built-in single-task behavior. */
  flow: string;
  runner: RunnerKind;
  /** Registered `http` runner the task routes to. */
  runnerId?: string;
  /** Effective permission after host, usage, and event narrowing. */
  permissions?: Permission;
  /** The platform event, or for a dashboard or CLI task on a repo, that repo through its install. */
  event?: AgentEvent;
  /** What a dashboard or CLI task asks; the newest turn after a continue. */
  prompt?: string;
  /** Flow arguments given directly, instead of derived from the event. */
  args?: Record<string, unknown>;
  /** Workspace MCP servers the task attaches, by name. */
  mcp?: string[];
  /** Handle the task posts as (GitHub `slug[bot]`, Slack bot user), so flows can trust only their own comments. */
  author?: string;
  definition: AgentDefinition;
  /** Frozen id of the credential selected for this task. */
  credential?: string;
  /** Wular user who asked, when known; their personal credential comes first. */
  requester?: string;
  /** Stored agent body for runners whose checkout does not contain the agent. */
  files?: Record<string, string>;
  usage?: AgentUsage;
  /** Effective tools per integration the task may act on (event integration + connections). */
  tools: Record<string, string[]>;
  /** Frozen per-integration write targets. Missing scope means read-only tools only. */
  toolScopes?: Record<
    string,
    {
      repo?: { owner: string; name: string };
      /** Chat SDK thread id. */
      thread?: string;
    }
  >;
  /** Conversation context gathered by the receiver: recent thread messages and the stored note. */
  context?: TaskContext;
}

export interface TaskContext {
  outputSchema?: object;
  /** Most recent thread messages, oldest first. */
  messages?: Array<{ user: string; text: string; ts: string }>;
  /** Completed turns of this task, kept across dashboard continuations. */
  turns?: TaskTurn[];
  /** Rolling note the agent wrote at the end of its previous turn in this thread. */
  note?: string;
  /** Extra instructions from the config repo (`.coder/<agent>.md`). */
  instructions?: string;
  /** The Coder account behind the event's actor, when they connected it. */
  user?: { name: string; email: string };
}
