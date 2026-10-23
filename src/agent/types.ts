import type { Access, Effort, McpConfigEntry } from '../core/config';
import type { Approval } from '../core/types';
import type { TaskTurn, RunnerKind } from '../client/types';
import type {
  PlatformApp,
  PlatformEvent,
  PlatformInstallation,
  SinceMessage,
} from '../integrations/types';

export type { RunnerKind } from '../client/types';

/** Event value in a definition map: `true`, or options. */
export interface AgentEventOptions {
  /** Regex the event text must match (e.g. keywords on Slack `message`). */
  match?: string;
}

/** Per-integration wiring in a definition: a list of event names, or a map of each to its value. */
export interface AgentDefinitionIntegration {
  events?: string[] | Record<string, true | AgentEventOptions>;
}

/** What an agent IS: `.coder/agents/<id>/agent.json` beside its system.md. */
export interface AgentDefinition {
  /** Display name used in replies; defaults to the id. */
  name?: string;
  description?: string;
  runner?: string;
  /** Its model spec: `<name>[/<effort>]` or `<engine>/<model>[/<effort>]`. */
  model?: string;
  /** Read-only or auto for every task, handle and connection it uses; defaults to `auto`. */
  access?: Access;
  /** MCP servers every task of this agent attaches, in the `.mcp.json` entry shape. */
  mcp?: Record<string, McpConfigEntry>;
  integrations: Record<string, AgentDefinitionIntegration>;
}

/** Per-integration caps in usage: `allowedEvents` intersects the definition's. */
export interface AgentUsageIntegration {
  allowedEvents?: string[];
}

/** How a repo RUNS an agent: one entry under `agents` in .coder/config.json, its `model` spec split. */
export interface AgentUsage {
  engine?: string;
  model?: string;
  effort?: Effort;
  /** May only lower the definition's access. */
  access?: Access;
  integrations?: Record<string, AgentUsageIntegration>;
  /** Connections its tasks may use, by id; absent allows every connection the task is granted. */
  connections?: string[];
  /** Off in this workspace; the other settings stay for when it is enabled again. */
  disabled?: boolean;
}

/** A task's usage, plus the model its latest turn ran. */
export interface TaskUsage extends AgentUsage {
  /** The engine, model and effort chosen for this task, by its starter or a later turn; it runs first, before its agent's model and the chain. */
  pick?: Pick<AgentUsage, 'engine' | 'model' | 'effort'>;
  resolvedModel?: string;
}

/** One attempt of a task's turn: a model as `engine/model/effort`, on one credential, or without one on its runner's own logins. */
export interface ModelAttempt {
  model: string;
  credential?: string;
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
export interface AgentEvent extends PlatformEvent {
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
}

/**
 * One platform app = one agent's handle. Created from the dashboard, or once per server for the built-in agent;
 * the receiver routes each webhook to its app by id. Store kind `app`, id `<integration>:<platform app id>`.
 */
export interface AgentApp extends PlatformApp {
  /** Agent id this app serves. */
  agent: string;
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
  /** `read-only` exposes only its read-only tools; absent or `auto` follows the task. */
  access?: Access;
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
  /** The login of a member's linked `account`, when the link knows it. */
  login?: string;
  /** The client that issued a personal native OAuth token. */
  oauthApp?: string;
  /** A refresh or call proved the secret dead; tasks skip it until it is reconnected. */
  broken?: { at: number; reason: string };
  createdAt: number;
  updatedAt?: number;
}

/** One install of an app. */
export type Installation = PlatformInstallation;

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
  /** Defaults to `auto`; at most its agent's and its parent's. */
  access?: Access;
  /** The platform event, or for a dashboard or CLI task on a repo, that repo through its install. */
  event?: AgentEvent;
  /** What a dashboard or CLI task asks; the newest turn after a continue. */
  prompt?: string;
  /** Flow arguments given directly, instead of derived from the event. */
  args?: Record<string, unknown>;
  /** Workspace MCP servers the task attaches, by name. */
  mcp?: string[];
  /** Standing instructions appended to the task's system prompt. */
  appendSystem?: string;
  /** Absolute directories beyond cwd the task may reach, kept only for runners on the caller's machine. */
  addDirs?: string[];
  /** Connection ids granted when the task was made; secrets are resolved only when it starts. */
  connections?: string[];
  /** Handle the task posts as (GitHub `slug[bot]`, Slack bot user), so flows can trust only their own comments. */
  author?: string;
  definition: AgentDefinition;
  /** What its turn runs, in order: each model on one frozen credential id, as the resolver answered for the turn's asker. */
  models?: ModelAttempt[];
  /** The linked member who started it, when known; their own turns run on their credentials first. */
  requestedBy?: string;
  /** The task that started this one through its Coder server; a parent sees only its children. */
  parent?: string;
  /** Who sees it, set once when it is created; a child copies its parent's. */
  audience?: string;
  /** The space it came from, own or inherited. */
  space?: string;
  /** Stored agent body for runners whose checkout does not contain the agent. */
  files?: Record<string, string>;
  usage?: TaskUsage;
  /** Effective tools per integration the agent declares, by its access mode; every installation of the agent's apps serves them. */
  tools: Record<string, string[]>;
  /** Context gathered by the receiver: notes for the turn and who asked. */
  context?: TaskContext;
  /** What the platform thread gets when the run fails without an answer. */
  failureReply?: string;
  /** The task's dashboard page, linked when the agent returns no reply where one is due. */
  taskUrl?: string;
  /** The agent's settings page, linked when its engine can't run the model it is set to. */
  settingsUrl?: string;
}

export interface TaskContext {
  outputSchema?: object;
  /** Earlier turns a dashboard continuation pastes in, oldest first. */
  messages?: Array<{ user: string; text: string; ts: string }>;
  /** Completed turns of this task, kept across dashboard continuations. */
  turns?: TaskTurn[];
  /** Notes the receiver adds for the agent, such as a missing account connection. */
  instructions?: string;
  /** Whether this turn requires a reply. */
  mustReply?: boolean;
  /** The last conversation batch each kind admitted, by steer or resume. */
  admissions?: Partial<Record<'batch' | 'reactions', string>>;
  /** The Coder account behind the event's actor, when they connected it. */
  user?: { name: string; email: string };
  /** The linked member whose message started this turn, in any conversation. */
  asker?: string;
  /** The task's escalations, answers included; a late answer resumes the task with them. */
  approvals?: Approval[];
}
