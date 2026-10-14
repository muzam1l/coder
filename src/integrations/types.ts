/** The contract every integration implements: a Chat SDK adapter, apps, tools, tokens and repository reads. */
import type { Adapter, Message, ReactionEvent, SerializedThread, StateAdapter, Thread } from 'chat';

import type { McpServerSpec } from '../core/types';
import type { McpTool } from '../utils/mcp-server';
import type { AgentApp, AgentDefinition, AgentEvent, Installation, Preset } from '../agent/types';

export type { McpServerSpec, AgentApp, AgentDefinition, AgentEvent, Installation, Preset };
export { PRESETS } from '../agent/types';

export interface ToolContext {
  token: string;
  fetch: typeof fetch;
  /** The task's allowed tools for this integration, such as Slack method names. */
  tools?: string[];
  /** Where the task may write: its repository, or its Chat SDK thread id. */
  scope?: {
    repo?: { owner: string; name: string };
    thread?: string;
    /** The covered account the task's event happened in. */
    within?: string;
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

/** What the dashboard's app creation puts in the URL; only `tx` goes to the platform and back. */
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
  /** Any account may install the app, not only the one that owns it. */
  public?: boolean;
}

/** One input of a create form. */
export interface CreateField {
  name: string;
  label: string;
  hint?: string;
  placeholder?: string;
  required?: true;
}

/** A create form as data: the dashboard renders it and posts the fields with `tx` to `/create/<id>/callback`. */
export interface CreateStep {
  /** One line on what creating the app does. */
  intro: string;
  /** Where the user gets the values. */
  link: string;
  /** Numbered steps; `link` is the platform page the step happens on, `copy` holds values to paste there. `text` marks the platform's own UI names **like this**. */
  steps: Array<{ text: string; link?: string; copy?: string[] }>;
  /** Advanced notes, shown collapsed under the steps; UI names marked **like this**. */
  notes?: string[];
  fields: CreateField[];
  /** Values posted with the fields as they are. */
  hidden?: Record<string, string>;
  submit: string;
}

export type IntegrationErrorCode =
  | 'platform-error'
  | 'missing-code'
  | 'invalid-field'
  | 'not-yours'
  | 'wrong-account'
  | 'no-refresh-token';

/** A platform step that failed in a way the person can act on; `error` is the platform's short error code or the field name. */
export class IntegrationError extends Error {
  constructor(
    readonly code: IntegrationErrorCode,
    readonly error?: string,
    message?: string,
  ) {
    super(message ?? (error ? `${code} (${error})` : code));
  }
}

/** A form the browser posts to the platform, such as GitHub's app manifest. */
export interface PlatformPost {
  url: string;
  fields: Record<string, string>;
}

/** Where an app is changed on its platform, and what to change there; UI names marked **like this**. */
export interface AppDrift {
  url: string;
  /** The link's words, such as `Open app settings`. */
  label: string;
  /** One setting each, with the value to enter. */
  lines: Array<{ text: string; copy?: string }>;
}

/** Creating one app per agent on the user's account, then installing it; all browser-driven. */
export interface IntegrationApp {
  /** Built-in agents install the server's one shared app (`shared`), or create their own in each workspace like any agent (`own`). */
  builtin: 'shared' | 'own';
  /** Origins `createPost` forms go to; the dashboard lets forms post only there. */
  postOrigins?: string[];
  /** The form that starts creation on the platform itself, posted by the browser. */
  createPost?(input: {
    publicUrl: string;
    state: CreateState;
    definition: AgentDefinition;
    encodedState: string;
  }): PlatformPost;
  /** The form that creates the app from values the user copies from the platform; used when there is no `createPost`. */
  createStep?(
    publicUrl: string,
    input?: { name?: string; shared?: boolean; public?: boolean },
  ): CreateStep;
  /** `/create/<id>/callback`: finish creation; credentials are stored encrypted by the caller, or `shared` keeps the shared app's. */
  createCallback(
    req: Request,
    input: {
      publicUrl: string;
      state: CreateState;
      definition: AgentDefinition;
      fetch: typeof fetch;
      /** Credentials of this server's shared app on the platform, when one exists. */
      shared?: unknown;
    },
  ): Promise<
    { platformAppId: string; name: string } & ({ credentials: unknown } | { shared: true })
  >;
  /** What `update` sends for a definition, such as the app manifest; an app is updated again only when it changes. */
  manifest?(app: AgentApp, input: { publicUrl: string; definition: AgentDefinition }): unknown;
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
  /** Changes the app on the platform needs for a definition, read from the platform; none when it is up to date. */
  drift?(
    app: AgentApp,
    credentials: unknown,
    input: { publicUrl: string; definition: AgentDefinition; fetch: typeof fetch },
  ): Promise<AppDrift>;
  /** Every value the app needs for a definition, where the platform can neither be read nor updated; the person confirms them by hand. */
  values?(app: AgentApp, input: { publicUrl: string; definition: AgentDefinition }): AppDrift;
  /** The app's settings page on the platform, where it is deleted. */
  settingsUrl?(app: AgentApp, credentials: unknown): string | undefined;
  /** An installed account's page on the platform. */
  accountUrl?(account: { login: string; type?: string }): string | undefined;
  /** Where the browser goes to install an existing app; `state` comes back to installCallback. With `installation`, a fresh authorization that verifies it. */
  installUrl(
    app: AgentApp,
    credentials: unknown,
    input: { publicUrl: string; state: string; installation?: string },
  ): string;
  /** The app and installation id of a platform-started install, checked with the platform, never read from the query. */
  installedApp?(
    req: Request,
    input: { apps: Array<{ app: AgentApp; credentials: unknown }>; fetch: typeof fetch },
  ): Promise<{ app: AgentApp; installation: string } | undefined>;
  /** `/install/<id>/callback`: the platform's install redirect or OAuth code. */
  installCallback(
    req: Request,
    input: {
      app: AgentApp;
      credentials: unknown;
      publicUrl: string;
      fetch: typeof fetch;
      /** A platform-started install to verify, from Coder's own state. */
      installation?: string;
    },
  ): Promise<{
    platformInstallId: string;
    account?: { login: string; type?: string; url?: string };
    /** Plaintext platform token to store encrypted (Slack bot token). */
    token?: string;
    installer?: string;
    /** The app's own platform user in the installation. */
    self?: string;
    /** Accounts an install spans; null keeps known grants when reading them failed. */
    covers?: string[] | null;
    /** The installer's verified platform identity, linked to the signed-in user. */
    user?: PlatformUser;
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
  authorizeUrl(
    credentials: unknown,
    input: { publicUrl: string; state: string; access?: 'observe' | 'write' },
  ): string;
  /** Exchange the callback's code for the user and their token. */
  exchange(
    req: Request,
    credentials: unknown,
    input: { publicUrl: string; fetch: typeof fetch; access?: 'observe' | 'write' },
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
  /** The app's own platform user in a bound installation, as stored at install. */
  installedSelf?(installationId: string): Promise<string | undefined>;
  /** Saves the app's platform user on an installation that lacks it, so it is looked up once. */
  saveSelf?(installationId: string, self: string): Promise<void>;
  /** A fresh in-memory Chat SDK state for caches the adapter must not share. */
  privateState?(): StateAdapter;
  /** Whether Coder acts on a plain message that neither mentions the app nor is direct, by its raw text; the adapter reads nothing more of one it does not. */
  hears?(text: string): Promise<boolean>;
  /** Whether Coder answered in this Chat SDK thread lately; only mentions, direct messages and such threads look up users. */
  active?(thread: string): Promise<boolean>;
  /** Coder's public address. */
  publicUrl?: string;
  /** The dashboard of the installation's workspace, for links to its pages. */
  dashUrl?: string;
  /** An agent of the workspace the installation is bound to, the app's own by default. */
  agent?(slug?: string): Promise<AgentSummary | undefined>;
  /** A task of the workspace the installation is bound to; none for any other. */
  task?(id: string): Promise<TaskSummary | undefined>;
}

/** An agent as a platform shows it: its current version. */
export interface AgentSummary {
  slug: string;
  name: string;
  description?: string;
  /** Platforms its definition wires, with the events on each. */
  listens: Array<{ integration: string; name: string; events: string[] }>;
}

/** A task as a platform shows it. */
export interface TaskSummary {
  id: string;
  title: string;
  agent: string;
  status: string;
  /** The platform that raised it, or `dashboard`, `cli` or `schedule`. */
  from: string;
  /** Epoch milliseconds; when it was queued if it has not started. */
  startedAt: number;
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
  | {
      installation: {
        op: 'upsert' | 'delete';
        installation: Installation;
        repos?: { add: string[]; remove: string[]; refresh?: true };
      };
    }
  | { covers: { installation: string; add?: string[]; remove?: string[] } }
  | { changes: { repo: string; ref: string; branch: string; paths?: string[] }; pushed?: Pushed }
  | { pushed: Pushed }
  /** Platform calls made after the webhook is answered, with the installation's adapter context. */
  | { work(ctx: AdapterContext): Promise<void> }
  /** A delivery that needs only an answer, such as a click on a button that opens a page. */
  | { ack: true }
  /** A delivery Coder does not act on yet, such as a button click; logged and acknowledged. */
  | { unhandled: string };

/** A push to a branch: repository files Coder holds for it are read again. */
export interface Pushed {
  installation: string;
  repo: string;
  branch: string;
  defaultBranch?: string;
}

/** What an unverified webhook names: the app whose secret verifies it, and the installation whose token is minted once it has. */
export interface WebhookTarget {
  /** Platform app id (GitHub `X-GitHub-Hook-Installation-Target-ID`, Slack `api_app_id`). */
  app: string;
  installation?: string;
  /** The covered account it happened in, for an installation that covers several. */
  within?: string;
  /** The repository it happened in, as a task checks it out. */
  repo?: NonNullable<AgentEvent['repo']>;
  /** The app's own platform user, so mentions of it are recognized. */
  self?: string;
}

/** What Coder lends a token mint. */
export interface TokenInput {
  /** Stores a refreshed installation token, or resolves to the one another refresh stored first. */
  save?(token: string): Promise<string | void>;
  /** Reuses a token minted for `key` (the app's credentials and the exact scope) while it has time left, else runs `mint`, whose expiry is in epoch ms. */
  hold?(key: string, mint: () => Promise<{ token: string; expiresAt: number }>): Promise<string>;
  fetch?: typeof globalThis.fetch;
}

/** Tokens: minted and narrowed by Coder, never by an adapter. */
export interface IntegrationAuth {
  /** Mint a token narrowed to `bound`: its repository and what its tools need. */
  token(
    installation: Installation,
    credentials: unknown,
    bound?: TokenBound,
    input?: TokenInput,
  ): Promise<string>;
  /** Linking by the app's user OAuth; without it, links go out privately as an ephemeral message. */
  user?: IntegrationUserAuth;
  /** Whether the event's actor may write where the event happened, checked with the platform. */
  canWrite?(event: AgentEvent, token: string, fetch?: typeof globalThis.fetch): Promise<boolean>;
}

/** Repository reads, for an integration that hosts code. */
export interface Repositories {
  /** HTTPS clone hosts it may place in a verified event. */
  readonly cloneHosts: readonly string[];
  readonly credentialUsername?: string;
  /** One file; `undefined` when it does not exist. */
  readFile(repo: string, path: string, token: string, ref?: string): Promise<string | undefined>;
  /** One file sent with the ETag of Coder's copy: `unchanged` while it matches, else its text (none when missing) and ETag. */
  revalidate?(
    repo: string,
    path: string,
    token: string,
    input: { ref?: string; etag?: string; fetch: typeof globalThis.fetch },
  ): Promise<'unchanged' | { text?: string; etag?: string }>;
  /** Entry names in a directory; `[]` when it does not exist. */
  listDir(repo: string, path: string, token: string, ref?: string): Promise<string[]>;
  /** The commit a ref points at; `undefined` when it does not exist. */
  commit(repo: string, ref: string, token: string): Promise<string | undefined>;
  /** `owner/name` of every repository an installation's token can read. */
  list(installation: Installation, token: string, request?: typeof fetch): Promise<string[]>;
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
  /** How people reach an installed agent there, `{handle}` standing for its handle. */
  readonly use?: string;
  /** Every prompt waits for its own answer, as a Linear agent session does, so notices repeat instead of going out once per thread. */
  readonly answersEveryPrompt?: true;
  /** What one account an installation covers is called, such as a Slack workspace of an org install. */
  readonly covered?: string;
  /** Apps may live under an organization instead of the creator's own account. */
  readonly organizationApps?: boolean;
  /** Apps may be public: installable by any account, not only the one that owns them. */
  readonly publicApps?: boolean;
  /** Listed first among an agent's handles. */
  readonly featured?: true;
  /** How an agent should write for this platform, added to its prompt for events from it. */
  readonly hint?: string;
  readonly events: Record<string, EventSpec>;
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
  /** The platform page of the thread or issue an event came from. */
  link?(event: AgentEvent): string | undefined;
  /** Greets the person who installed the app, right after the install: `open` is the agent in Coder, `setup` the missing model. */
  welcome?(
    ctx: AdapterContext,
    installer: string,
    links: { open: string; setup?: string },
  ): Promise<void>;
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
