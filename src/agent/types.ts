import type { SerializedMessage, SerializedThread } from 'chat';

import type { Effort, McpConfigEntry, Permission } from '../core/config';
import type { TaskTurn, RunnerKind } from '../client/types';
import type { SinceMessage } from '../integrations/types';

export type Preset = 'observe' | 'comment' | 'write';
export const PRESETS: Preset[] = ['observe', 'comment', 'write'];

export type { RunnerKind } from '../client/types';

/** Per-integration wiring in a definition. `events` list = default behavior, map = event -> flow. */
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
  events?: string[] | Record<string, string | true | AgentEventOptions>;
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
  /** Connections its tasks may use, by id; absent allows every connection the task is granted. */
  connections?: string[];
  /** Off in this workspace; the other settings stay for when it is enabled again. */
  disabled?: boolean;
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
  /** The covered account it happened in, for an installation that covers several. */
  within?: string;
  /** The Chat SDK thread and message it happened in, without raw platform payloads; replies go to this thread. */
  chat?: { thread: SerializedThread; message?: SerializedMessage };
  /** Whether the agent must answer: a mention, a 1:1 direct message, or a handle that answers every prompt. */
  mustReply?: boolean;
  /** The event's place in its conversation, gathered at dispatch; `more` counts messages past `since`'s cap. */
  conversation?: {
    index?: number;
    since?: SinceMessage[];
    more?: number;
    /** Internal acknowledgement watermark of the recorded unseen snapshot. */
    unseen?: { version: number; epoch?: string };
  };
  repo?: {
    owner: string;
    name: string;
    cloneUrl: string;
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
  /** The server's shared app whose credentials this app reads; it keeps no copy of its own. */
  shared?: string;
  /** Encrypted JSON (`encryptSecret`) of `GithubAppCredentials` or `SlackAppCredentials`. */
  credentials: string;
  createdAt: number;
}

/** A handle on another integration, linked to this installation at install time. */
export type InstallationLink = { kind: 'installation'; id: string };

/**
 * Access to a service with no handle: an MCP server, or a native integration's token. It wakes nothing.
 * Store kind `connection`; id is the slug, or `<user id>:<slug>` for a member's own.
 */
export interface Connection {
  id: string;
  name: string;
  /** `mcp`, or the integration id whose API the token reaches (`github`, `linear`). */
  provider: 'mcp' | (string & {});
  /** The member it belongs to; absent for the workspace's. */
  owner?: string;
  access: 'observe' | 'write';
  /** Where the secret goes, without secret values; repository entries can name the connection but never change it. */
  endpoint?: McpConfigEntry;
  auth: 'none' | 'key' | 'oauth';
  /** Where a key goes: a header (`Authorization` gets `Bearer `), or an env name for a stdio server. */
  keyIn?: { header: string } | { env: string };
  /** Encrypted JSON: `{ key }`, or the OAuth client, endpoints and tokens. */
  secret?: string;
  /** The credential whose `keyIn.env` value an `env` connection injects; rotating it rotates the connection. */
  credential?: string;
  /** Platform account or login that authorized it, for display. */
  account?: string;
  /** The client that issued a personal native OAuth token. */
  oauthApp?: string;
  /** A refresh or call proved the secret dead; tasks skip it until it is reconnected. */
  broken?: { at: number; reason: string };
  createdAt: number;
  updatedAt?: number;
}

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
  /** `url`: the account's page on the platform, when the install learned it. */
  account: { login: string; type?: string; url?: string };
  /** Secret the platform hands out once (Slack bot token), encrypted at rest. */
  token?: string;
  /** Platform user who installed (Slack user id); used for the welcome DM. */
  installer?: string;
  /** The app's own platform user here, as the platform named it at install (Linear's app user). */
  self?: string;
  /** Accounts an install spanning several covers (Slack workspaces of an org install). */
  covers?: string[];
  repos?: string[];
  /** Other integrations this install can act on, keyed by integration id. */
  connections?: Record<string, InstallationLink>;
  settings?: InstallationSettings;
  createdAt: number;
  deletedAt?: number;
  uninstalled?: boolean;
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
  /** Connection ids granted when the task was made; secrets are resolved only when it starts. */
  connections?: string[];
  /** Handle the task posts as (GitHub `slug[bot]`, Slack bot user), so flows can trust only their own comments. */
  author?: string;
  definition: AgentDefinition;
  /** Frozen id of the credential selected for this task. */
  credential?: string;
  /** The engine order for this task; a pinned engine has one entry. */
  engineChain?: string[];
  /** Applicable credentials frozen with the engine order, without their values. */
  engineCredentials?: Record<string, string>;
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
      within?: string;
    }
  >;
  /** Context gathered by the receiver: repository instructions and who asked. */
  context?: TaskContext;
  /** What the platform thread gets when the run fails without an answer. */
  failureReply?: string;
  /** The task's dashboard page, linked when the agent returns no reply where one is due. */
  taskUrl?: string;
}

export interface TaskContext {
  outputSchema?: object;
  /** Earlier turns a dashboard continuation pastes in, oldest first. */
  messages?: Array<{ user: string; text: string; ts: string }>;
  /** Completed turns of this task, kept across dashboard continuations. */
  turns?: TaskTurn[];
  /** Extra instructions from the config repo (`.coder/<agent>.md`). */
  instructions?: string;
  /** The config repo `instructions` came from. */
  repository?: string;
  /** Whether this turn requires a reply. */
  mustReply?: boolean;
  /** The last conversation batch each kind admitted, by steer or resume. */
  admissions?: Partial<Record<'batch' | 'reactions', string>>;
  /** The Coder account behind the event's actor, when they connected it. */
  user?: { name: string; email: string };
}
