/** The contract every integration implements: a Chat SDK adapter, apps, tools, tokens and repository reads. */
import type { Adapter, Message, ReactionEvent, SerializedThread, Thread } from 'chat';

import type { McpServerSpec } from '../core/types';
import type { McpTool } from '../utils/mcp-server';
import type { AgentApp, AgentDefinition, AgentEvent, Installation, Preset } from '../agent/types';

export interface ToolContext {
  token: string;
  fetch: typeof fetch;
  /** The task's allowed tools for this integration, such as Slack method names. */
  tools?: string[];
  /** Where the task may write: its repository, or its Chat SDK thread id. */
  scope?: {
    repo?: { owner: string; name: string };
    thread?: string;
  };
}

export type AgentTool = McpTool<ToolContext>;

export type ToolSet = Record<string, AgentTool>;

/** Presets map to tool allowlists; `serve` is coder's own `agent tools <integration>` server, `server` an external one. */
export interface IntegrationTools {
  presets: Record<Preset, string[]>;
  serve?: ToolSet;
  /** Shell command a Linux runner runs as root to install `server`'s binary. */
  install?: string;
  server?(tools: string[], event: AgentEvent | undefined, token: string): McpServerSpec;
}

/** What the dashboard's app creation puts in the URL and what comes back through the platform's `state`. */
export interface CreateState {
  agent: string;
  repo?: string;
  branch?: string;
  /** base64url `agent.json`. */
  def: string;
  /** Signed, stored browser transaction returned by the platform callback. */
  tx?: string;
  /** Where the app lives, such as a GitHub organization; the creator's own account when absent. */
  owner?: string;
  /** A server-level app anyone may install. */
  public?: boolean;
}

/** Creating one app per agent on the user's account, then installing it; all browser-driven. */
export interface IntegrationApp {
  /** `GET /create/<id>`: the page that starts creation (auto-submits a manifest, or asks for a token). */
  createPage(input: {
    publicUrl: string;
    state: CreateState;
    definition: AgentDefinition;
    encodedState: string;
  }): Response;
  /** `/create/<id>/callback`: finish creation; credentials are stored encrypted by the caller. */
  createCallback(
    req: Request,
    input: {
      publicUrl: string;
      state: CreateState;
      definition: AgentDefinition;
      fetch: typeof fetch;
    },
  ): Promise<{ platformAppId: string; name: string; credentials: unknown }>;
  /** Bring the platform's copy of the app in line with a new definition; returns credentials to store when they rotated. */
  update?(
    app: AgentApp,
    credentials: unknown,
    input: {
      publicUrl: string;
      definition: AgentDefinition;
      fetch: typeof fetch;
      saveCredentials(credentials: unknown): Promise<void>;
    },
  ): Promise<unknown | undefined>;
  /** Where the browser goes to install an existing app; `state` comes back to installCallback. */
  installUrl(
    app: AgentApp,
    credentials: unknown,
    input: { publicUrl: string; state: string },
  ): string;
  /** `/install/<id>/callback`: the platform's install redirect or OAuth code. */
  installCallback(
    req: Request,
    input: {
      app: AgentApp;
      credentials: unknown;
      publicUrl: string;
      fetch: typeof fetch;
      /** Install links for this agent's apps on other integrations, given the new installation's id. */
      connect: (installationId: string) => Promise<Record<string, string>>;
    },
  ): Promise<{
    platformInstallId: string;
    account?: { login: string; type?: string };
    /** Plaintext platform token to store encrypted (Slack bot token). */
    token?: string;
    installer?: string;
    /** The installer's verified platform identity, linked to the signed-in user. */
    user?: PlatformUser;
    response: Response;
  }>;
}

/** A platform user proven by the platform's own OAuth; `token` is the plaintext user token JSON. */
export interface PlatformUser {
  id: string;
  login?: string;
  token?: string;
}

/** The app's user OAuth, the proof used to link a platform user where messages are public. */
export interface IntegrationUserAuth {
  authorizeUrl(credentials: unknown, input: { publicUrl: string; state: string }): string;
  /** Exchange the callback's code for the user and their token. */
  exchange(
    req: Request,
    credentials: unknown,
    input: { publicUrl: string; fetch: typeof fetch },
  ): Promise<PlatformUser>;
  /** A usable access token from the stored token JSON, and the JSON to store when it was refreshed. */
  access(
    token: string,
    credentials: unknown,
    input: { fetch: typeof fetch; now: number },
  ): Promise<{ accessToken: string; refreshed?: string }>;
}

/** What Coder hands an integration's Chat SDK adapter. */
export interface AdapterContext {
  fetch: typeof fetch;
  /** The platform's own id for the app. */
  appId: string;
  /** The app's handle, which mentions name. */
  name: string;
  /** Decrypted app credentials; absent where the adapter only posts (a task's runner), so it verifies nothing. */
  credentials?: unknown;
  /** The installation this adapter serves; absent when the adapter reads it from each webhook (Slack). */
  installationId?: string;
  /** The app's own platform user, as the webhook names it, so mentions of it are recognized. */
  self?: string;
  /** A token for a bound installation, minted and narrowed by Coder; throws for one that is not bound. */
  token(installationId: string, bound?: TokenBound): Promise<string>;
  /** Check a webhook's installation without minting a platform token. */
  isBound?(installationId: string): Promise<boolean>;
}

/** Chat SDK handlers that raise Coder events. */
export type ChatRoute = 'mention' | 'message' | 'reaction' | 'command';

/** One catalog event: what it is, the Chat SDK handler that raises it, and how it is gated. */
export interface EventSpec {
  description: string;
  /** The Chat SDK handler that raises it; events the integration parses itself have none. */
  on?: ChatRoute;
  /** Fires on every message and usually wants a text filter. */
  noisy?: true;
  /** A person asks the agent directly; only linked workspace members run it. */
  addressed?: true;
  /** A follow-up in a thread whose task still runs steers that task instead of starting another. */
  steers?: true;
}

/** A signed webhook the adapter does not cover, verified by the integration itself. */
export type OwnEvent =
  | { invalid: true }
  | { events: AgentEvent[] }
  | { installation: { op: 'upsert' | 'delete'; installation: Installation } }
  | { changes: { repo: string; ref: string; branch: string; paths?: string[] } };

/** What an unverified webhook names: the app whose secret verifies it, and the installation whose token is minted once it has. */
export interface WebhookTarget {
  /** Platform app id (GitHub `X-GitHub-Hook-Installation-Target-ID`, Slack `api_app_id`). */
  app: string;
  installation?: string;
  /** The repository it happened in, as a task checks it out. */
  repo?: NonNullable<AgentEvent['repo']>;
  /** The app's own platform user, so mentions of it are recognized. */
  self?: string;
}

/** Tokens: minted and narrowed by Coder, never by an adapter. */
export interface IntegrationAuth {
  /** Mint a token narrowed to `bound`: its repository and what its tools need; `save` stores a refreshed installation token. */
  token(
    installation: Installation,
    credentials: unknown,
    bound?: TokenBound,
    save?: (token: string) => Promise<void>,
  ): Promise<string>;
  /** Linking by the app's user OAuth; without it, links go out privately as an ephemeral message. */
  user?: IntegrationUserAuth;
  /** Whether the event's actor may write where the event happened, checked with the platform. */
  canWrite?(event: AgentEvent, token: string): Promise<boolean>;
}

/** Repository reads, for an integration that hosts code. */
export interface Repositories {
  /** HTTPS clone hosts it may place in a verified event. */
  readonly cloneHosts: readonly string[];
  /** One file; `undefined` when it does not exist. */
  readFile(repo: string, path: string, token: string, ref?: string): Promise<string | undefined>;
  /** Entry names in a directory; `[]` when it does not exist. */
  listDir(repo: string, path: string, token: string, ref?: string): Promise<string[]>;
  /** The commit a ref points at; `undefined` when it does not exist. */
  commit(repo: string, ref: string, token: string): Promise<string | undefined>;
  /** `owner/name` of every repository an installation's token can read. */
  list(installation: Installation, token: string): Promise<string[]>;
  /** One repository as a task checks it out, at its default branch. */
  get(repo: string, token: string): Promise<NonNullable<AgentEvent['repo']>>;
  /** Browser address of a repository folder. */
  url(repo: string, path?: string, ref?: string): string;
  /** Open pull requests, newest first. */
  pullRequests(repo: string, token: string): Promise<PullRequestSummary[]>;
  /** The pull request an event is about, for the built-in review flows. */
  pullRequest(event: AgentEvent): number | undefined;
  /** A pull request's Chat SDK thread, for tasks started on it from the dashboard. */
  pullRequestThread(repo: string, number: number): SerializedThread;
}

export interface Integration {
  readonly id: string;
  /** The platform.s name as people write it. */
  readonly name: string;
  /** SVG artwork is static, sanitized at build time, with a 24x24 viewBox. */
  readonly brand: { color: string; icon: string; dark?: string; svg?: string };
  /** One line for lists and pickers. */
  readonly description: string;
  /** The button that installs an app, in the platform's own words. */
  readonly installLabel?: string;
  /** Apps may live under an organization instead of the creator's own account. */
  readonly organizationApps?: boolean;
  /** How an agent should write for this platform, added to its prompt for events from it. */
  readonly hint?: string;
  readonly events: Record<string, EventSpec>;
  /** Coder reads no thread history here, because the platform's needs more than the bot's own token (Teams' Graph). */
  readonly history?: false;
  /** Where the sample events `agent init` writes happen: a Chat SDK thread id. */
  readonly sample?: string;
  /** The handle an app posts as, so flows trust only its own comments; default is the app name. */
  author?(appName: string): string;
  readonly app: IntegrationApp;
  readonly auth: IntegrationAuth;
  readonly tools: IntegrationTools;
  readonly repos?: Repositories;
  /** A webhook's target, or the answer to a handshake that names no app (Slack URL verification). */
  target(req: Request, raw: string): WebhookTarget | Response | undefined;
  /** The app's Chat SDK adapter, built per request; every secret is passed explicitly, never read from the environment. */
  adapter(ctx: AdapterContext): Promise<Adapter>;
  /** The platform delivery or activity that raised a reaction. */
  reactionId?(reaction: ReactionEvent): string | undefined;
  /** Keep a bound installation's platform subscription alive and catch up on what it missed; runs after binding and on the server's sweep. */
  renew?(adapter: Adapter): Promise<void>;
  /** Catch up on what the platform could not push; runs every minute on a server with no public URL. */
  sync?(adapter: Adapter): Promise<void>;
  /** Signed webhooks the adapter does not handle (GitHub pull requests, issues, installs and pushes); `undefined` leaves it to the adapter. */
  ownEvents?(req: Request, raw: string, app: AgentApp, credentials: unknown): OwnEvent | undefined;
  /** What core cannot read from a Chat SDK message, such as the actor's role; `undefined` drops it. */
  event?(
    type: string,
    thread: Thread,
    message: Message,
    app: AgentApp,
  ): Pick<AgentEvent, 'type' | 'actor' | 'promptContext'> | undefined;
}

/** What a minted token may reach: one repository, and the permissions its tools need. */
export interface TokenBound {
  repo?: { owner: string; name: string };
  tools?: string[];
}

export interface PullRequestSummary {
  number: number;
  title: string;
  author?: string;
  createdAt?: string;
}
