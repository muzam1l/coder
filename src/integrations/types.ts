/** The contract every integration implements: a Chat SDK adapter, apps, tools, tokens and repository reads. */
import type {
  Adapter,
  Message,
  SerializedMessage,
  SerializedThread,
  StateAdapter,
  Thread,
} from 'chat';

/** Access modes: read-only tools, or tools that also write. */
export type Preset = 'read' | 'write';
export const PRESETS: Preset[] = ['read', 'write'];

/** A platform event, typed by its integration. */
export interface PlatformEvent {
  integration: string;
  /** Catalog name, e.g. `pull_request` or `mention`. */
  type: string;
  /** `PlatformApp.id` the webhook was addressed to. */
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
  repo?: {
    owner: string;
    name: string;
    cloneUrl: string;
    defaultBranch: string;
  };
}

/** One platform app; id `<integration>:<platform app id>`. */
export interface PlatformApp {
  id: string;
  integration: string;
  /** App handle: GitHub app slug (`@slug`), Slack bot user name. */
  name: string;
}

/** One install of an app: a GitHub installation or a Slack workspace. Id `<app id>:<platform install id>`. */
export interface PlatformInstallation {
  id: string;
  app: string;
  integration: string;
  /** `url`: the account's page on the platform, when the install learned it. */
  account: { login: string; type?: string; url?: string };
  /** Secret the platform hands out once (Slack bot token), encrypted at rest. */
  token?: string;
  /** Platform user who installed (Slack user id). */
  installer?: string;
  /** The app's own platform user here, as the platform named it at install (Linear's app user). */
  self?: string;
  /** Accounts an install spanning several covers (Slack workspaces of an org install). */
  covers?: string[];
  repos?: string[];
  createdAt: number;
  deletedAt?: number;
  uninstalled?: boolean;
}

/** An MCP server running a platform's tools. */
export interface ToolServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Remote server, streamable HTTP. */
  url?: string;
  headers?: Record<string, string>;
  /** Where the token goes, so a host can swap it. */
  credentialFields?: { env?: string; header?: string };
  /** Only tools the server marks read-only may be called. */
  readOnly?: boolean;
}

/** Access modes select the platform server's tools. */
export interface IntegrationTools {
  presets: Record<Preset, string[]>;
  /** Shell command a Linux runner runs as root to install `server`'s binary. */
  install?: string;
  /** Hosts `install` downloads from, redirects included. */
  installHosts?: string[];
  server(tools: string[], event: PlatformEvent | undefined, token: string): ToolServer;
}

/** What an app is made from: its name, what it listens to and what its tools may do. */
export interface AppSpec {
  name: string;
  description?: string;
  /** Catalog events it listens to. */
  events: string[];
  /** Defaults to `write`. */
  access?: Preset;
  /** Slash commands it registers, where the platform has them. */
  commands?: Array<{ command: string; description: string; usage?: string }>;
}

/** One input of a create form. */
export interface CreateField {
  name: string;
  label: string;
  hint?: string;
  placeholder?: string;
  required?: true;
  /** Rendered as a select; the first option is the default. */
  options?: Array<{ value: string; label: string }>;
  /** Shown, and posted, only while that field holds that value. */
  when?: { field: string; equals: string };
}

/** A create form as data: a host renders it and posts the fields with `tx` to `/create/<id>/callback`. */
export interface CreateStep {
  /** One line on what creating the app does. */
  intro: string;
  /** Where the user gets the values. */
  link: string;
  /** Numbered steps; `link` is the platform page the step happens on, `copy` holds values to paste there. `text` marks the platform's own UI names **like this**. */
  steps: Array<{
    text: string;
    link?: string;
    copy?: string[];
    when?: { field: string; equals: string };
  }>;
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

/** Stored platform configuration tokens, such as Slack's, keyed by the platform workspace they belong to. */
export interface AppTokens {
  put(value: {
    workspace: string;
    user: string;
    workspaceName: string;
    credentials: unknown;
  }): Promise<string>;
  use<T>(
    id: string,
    run: (
      credentials: unknown,
      save: (credentials: unknown, workspaceName?: string) => Promise<void>,
      invalidate: () => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
}

/** Creating an app on the user's account, then installing it; all browser-driven. */
export interface IntegrationApp {
  /** One app may serve every account that installs it, so a host can share one app among its users. */
  shareable?: true;
  /** Origins `createPost` forms go to; a host lets forms post only there. */
  postOrigins?: string[];
  /** The form that starts creation on the platform itself, posted by the browser; `state` comes back to `createCallback`. */
  createPost?(input: {
    publicUrl: string;
    spec: AppSpec;
    state: string;
    /** Where the app lives, such as a GitHub organization; the creator's own account when absent. */
    owner?: string;
    /** Any account may install the app, not only the one that owns it. */
    public?: boolean;
  }): PlatformPost;
  /** The form that creates the app from values the user copies from the platform; used when there is no `createPost`. */
  createStep?(
    publicUrl: string,
    input?: {
      name?: string;
      shared?: boolean;
      public?: boolean;
      /** Saved configuration tokens, most recently used first. */
      saved?: Array<{ id: string; label: string }>;
    },
  ): CreateStep;
  /** `/create/<id>/callback`: finish creation; credentials are stored encrypted by the caller, or `shared` keeps the shared app's. */
  createCallback(
    req: Request,
    input: {
      publicUrl: string;
      spec: AppSpec;
      fetch: typeof fetch;
      /** Credentials of the host's shared app on the platform, when one exists. */
      shared?: unknown;
      tokens?: AppTokens;
    },
  ): Promise<
    { platformAppId: string; name: string } & ({ credentials: unknown } | { shared: true })
  >;
  /** What `update` sends for a spec, such as the app manifest; an app is updated again only when it changes. */
  manifest?(app: PlatformApp, input: { publicUrl: string; spec: AppSpec }): unknown;
  /** Bring the platform's copy of the app in line with a new spec; returns credentials to store when they rotated. */
  update?(
    app: PlatformApp,
    credentials: unknown,
    input: {
      publicUrl: string;
      spec: AppSpec;
      fetch: typeof fetch;
      saveCredentials(credentials: unknown): Promise<void>;
      tokens?: AppTokens;
    },
  ): Promise<unknown | undefined>;
  /** Changes the app on the platform needs for a spec, read from the platform; none when it is up to date. */
  drift?(
    app: PlatformApp,
    credentials: unknown,
    input: { publicUrl: string; spec: AppSpec; fetch: typeof fetch },
  ): Promise<AppDrift>;
  /** Every value the app needs for a spec, where the platform can neither be read nor updated; the person confirms them by hand. */
  values?(app: PlatformApp, input: { publicUrl: string; spec: AppSpec }): AppDrift;
  /** The app's settings page on the platform, where it is deleted. */
  settingsUrl?(app: PlatformApp, credentials: unknown): string | undefined;
  /** An installed account's page on the platform. */
  accountUrl?(account: { login: string; type?: string }): string | undefined;
  /** Where the browser goes to install an existing app; `state` comes back to installCallback. With `installation`, a fresh authorization that verifies it. */
  installUrl(
    app: PlatformApp,
    credentials: unknown,
    input: { publicUrl: string; state: string; installation?: string },
  ): string;
  /** The app and installation id of a platform-started install, checked with the platform, never read from the query. */
  installedApp?<A extends PlatformApp>(
    req: Request,
    input: { apps: Array<{ app: A; credentials: unknown }>; fetch: typeof fetch },
  ): Promise<{ app: A; installation: string } | undefined>;
  /** `/install/<id>/callback`: the platform's install redirect or OAuth code. */
  installCallback(
    req: Request,
    input: {
      app: PlatformApp;
      credentials: unknown;
      publicUrl: string;
      fetch: typeof fetch;
      tokens?: AppTokens;
      /** A platform-started install to verify, from the host's own state. */
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
    input: { publicUrl: string; state: string; access?: 'read' | 'write' },
  ): string;
  /** Exchange the callback's code for the user and their token. */
  exchange(
    req: Request,
    credentials: unknown,
    input: { publicUrl: string; fetch: typeof fetch; access?: 'read' | 'write' },
  ): Promise<PlatformUser>;
  /** A usable access token from the stored token JSON, and the JSON to store when it was refreshed. */
  access(
    token: string,
    credentials: unknown,
    input: { fetch: typeof fetch; now: number },
  ): Promise<{ accessToken: string; refreshed?: string }>;
}

/** What the host hands an integration's Chat SDK adapter. */
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
  /** A token for a bound installation, minted and narrowed by the host; throws for one that is not bound. */
  token(installationId: string, bound?: TokenBound): Promise<string>;
  /** The app's own platform user in a bound installation, as stored at install. */
  installedSelf?(installationId: string): Promise<string | undefined>;
  /** Saves the app's platform user on an installation that lacks it, so it is looked up once. */
  saveSelf?(installationId: string, self: string): Promise<void>;
  /** A fresh in-memory Chat SDK state for caches the adapter must not share. */
  privateState?(): StateAdapter;
  /** Whether the app takes this plain message. */
  hears?(type: string, text: string): Promise<boolean>;
  /** Whether the app answered in this Chat SDK thread lately; only mentions, direct messages and such threads look up users. */
  active?(thread: string): Promise<boolean>;
  /** Whether the message belongs to a conversation the host knows. */
  knows?(channel: string, message: string): Promise<boolean>;
  /** The app's own page on the platform, such as Slack's Home tab; none leaves it unpublished. */
  home?(): Promise<Page | undefined>;
  /** A card for a shared link the host recognizes; none leaves the link as it is. */
  preview?(url: string): Promise<Card | undefined>;
}

/** A button that opens a page; `id` tells the buttons of one page apart. */
export interface LinkButton {
  id: string;
  label: string;
  url: string;
  primary?: boolean;
}

/** A page as data, laid out by the platform: a bold title over its text, sections, then buttons. Text is plain. */
export interface Page {
  title: string;
  text?: string;
  sections: Array<{ title: string; text: string }>;
  links: LinkButton[];
}

/** A shared link's card: a linked title, its text, labelled fields and a footer. Text is plain; `at` is epoch ms. */
export interface Card {
  title: string;
  url: string;
  text?: string;
  fields?: Array<{ label: string; text: string } | { label: string; at: number }>;
  footer: string;
}

/** Chat SDK handlers that raise catalog events. */
export type ChatRoute = 'mention' | 'message' | 'command';

/** One catalog event: what it is, the Chat SDK handler that raises it, and how it is gated. */
export interface EventSpec {
  description: string;
  /** The Chat SDK handler that raises it; events the integration parses itself have none. */
  on?: ChatRoute;
  /** Fires on every message and usually wants a text filter; listed after the other events and off by default. */
  noisy?: true;
  /** A person asks the app directly. */
  addressed?: true;
}

/** A message the agent did not get as a turn, as `since` lists it. */
export interface SinceMessage {
  /** The platform's message id, so a message counts once; not shown to the agent. */
  id?: string;
  author: string;
  text: string;
  sentAt: string;
}

/** What the host lends an integration's conversation hook. */
export interface ConversationAccess {
  /** The installation's read token. */
  token(): Promise<string | undefined>;
  fetch: typeof fetch;
  /** Whether every message of the conversation reaches the host as an event, so none needs fetching. */
  delivered: boolean;
  /** The id of the last message the agent saw in this conversation; absent on a task's first turn. */
  after?: string;
}

/** Conversation facts for the event the agent reads; each part is best-effort and absent where it has no meaning. */
export interface ConversationFacts {
  /** The message's position in its conversation, 0 = first. */
  index?: number;
  /** Messages posted after `after` that the agent has not seen, oldest first, with bots and the app's own posts left out. */
  since?: SinceMessage[];
}

/** A signed webhook the adapter does not cover, verified by the integration itself. */
export type OwnEvent =
  | { invalid: true }
  | { uninstalled: string }
  | { events: PlatformEvent[] }
  | {
      installation: {
        op: 'upsert' | 'delete';
        installation: PlatformInstallation;
        repos?: { add: string[]; remove: string[]; refresh?: true };
      };
    }
  | { covers: { installation: string; add?: string[]; remove?: string[] } }
  | { push: Push }
  /** Platform calls made after the webhook is answered, with the installation's adapter context. */
  | { work(ctx: AdapterContext): Promise<void> }
  /** A delivery that needs only an answer, such as a click on a button that opens a page. */
  | { ack: true }
  /** A person clicked a button the app posted. */
  | { click: Click }
  /** A delivery the host does not act on yet, such as a button click; logged and acknowledged. */
  | { unhandled: string };

/** A button under a message; `value` comes back with the click. */
export interface Button {
  label: string;
  value: string;
  style?: 'primary' | 'danger';
  /** Asked before the click goes through, where the platform can ask. */
  confirm?: string;
  /** Asks for optional text before the click goes through, where the platform can (`IntegrationMessages.asks`); the click carries it. */
  ask?: { label: string; placeholder?: string };
}

/** A message as the host writes it; a platform without buttons posts the text alone. */
export interface MessageDraft {
  markdown: string;
  /** Shown as a card where the platform has one: `title` over `body`, the buttons inside, `status` (markdown) under them, `outcome` once settled; `markdown` stays the full text. */
  card?: { title: string; body: string; status?: string; outcome?: 'success' | 'failure' };
  /** Shown after `markdown`, collapsed under `summary` where the platform can; `items` lists its entries one by one where the platform can. */
  collapsed?: { summary: string; markdown: string; items?: string[] };
  buttons?: Button[];
  /** A short line under the buttons. */
  hint?: string;
  /** A button that opens a page. */
  link?: { label: string; url: string };
}

/** A click on a button the app posted. */
export interface Click {
  /** The Chat SDK thread the message is in. */
  thread: string;
  /** The platform's id of the message. */
  message?: string;
  value: string;
  /** What the person wrote where the button asked for text. */
  text?: string;
  actor: PlatformEvent['actor'];
}

/** Where a message goes: a conversation, and its installation for platform calls. */
export interface MessagePlace {
  ctx: AdapterContext;
  thread: Thread;
}

/** Messages with buttons; without this, `thread.post` and `editMessage` carry the text alone. */
export interface IntegrationMessages {
  /** Posts in the thread; returns the message id `edit` changes. */
  post(place: MessagePlace, message: MessageDraft): Promise<string | undefined>;
  /** Changes a posted message in place; absent where the platform cannot edit. */
  edit?(place: MessagePlace, id: string, message: MessageDraft): Promise<void>;
  /** Sends a person a direct message laid out as a page. */
  direct?(ctx: AdapterContext, user: string, page: Page): Promise<void>;
  /** Buttons can ask for text (`Button.ask`); elsewhere they click as they are. */
  readonly asks?: true;
  /** A click uses the buttons up: the platform drops them with the answer. */
  readonly clickConsumes?: true;
  /** A later message in the thread dismisses earlier buttons, so buttons still wanted go out again after it. */
  readonly laterDismisses?: true;
}

/** A push to a branch, with the paths its listed commits touched. */
export interface Push {
  /** Absent when the webhook names no installation. */
  installation?: string;
  repo: string;
  branch: string;
  /** The commit the branch now points at. */
  commit?: string;
  defaultBranch?: string;
  paths: string[];
  /** The payload lists no commits, or the platform cut the list, so `paths` may miss some. */
  partial?: true;
}

/** What an unverified webhook names: the app whose secret verifies it, and the installation whose token is minted once it has. */
export interface WebhookTarget {
  /** Platform app id (GitHub `X-GitHub-Hook-Installation-Target-ID`, Slack `api_app_id`). */
  app: string;
  installation?: string;
  /** The covered account it happened in, for an installation that covers several. */
  within?: string;
  /** The repository it happened in, as a task checks it out. */
  repo?: NonNullable<PlatformEvent['repo']>;
  /** The app's own platform user, so mentions of it are recognized. */
  self?: string;
  /** The message's position in its conversation when the webhook states it (GitHub's comment count), 0 = first. */
  index?: number;
}

/** What the host lends a token mint. */
export interface TokenInput {
  /** Stores a refreshed installation token, or resolves to the one another refresh stored first. */
  save?(token: string): Promise<string | void>;
  /** Reuses a token minted for `key` (the app's credentials and the exact scope) while it has time left, else runs `mint`, whose expiry is in epoch ms. */
  hold?(key: string, mint: () => Promise<{ token: string; expiresAt: number }>): Promise<string>;
  fetch?: typeof globalThis.fetch;
}

/** Tokens: minted and narrowed by the host, never by an adapter. */
export interface IntegrationAuth {
  /** Mint a token narrowed to `bound`: what its tools need. */
  token(
    installation: PlatformInstallation,
    credentials: unknown,
    bound?: TokenBound,
    input?: TokenInput,
  ): Promise<string>;
  /** Linking by the app's user OAuth; without it, links go out privately as an ephemeral message. */
  user?: IntegrationUserAuth;
  /** Whether the event's actor may write where the event happened, checked with the platform. */
  canWrite?(event: PlatformEvent, token: string, fetch?: typeof globalThis.fetch): Promise<boolean>;
}

/** Repository reads, for an integration that hosts code. */
export interface Repositories {
  /** HTTPS clone hosts it may place in a verified event. */
  readonly cloneHosts: readonly string[];
  readonly credentialUsername?: string;
  /** One file; `undefined` when it does not exist. */
  readFile(repo: string, path: string, token: string, ref?: string): Promise<string | undefined>;
  /** One file sent with the ETag of the caller's copy: `unchanged` while it matches, else its text (none when missing) and ETag. */
  revalidate?(
    repo: string,
    path: string,
    token: string,
    input: { ref?: string; etag?: string; fetch: typeof globalThis.fetch },
  ): Promise<'unchanged' | { text?: string; etag?: string }>;
  /** Entry names in a directory; `[]` when it does not exist. */
  listDir(repo: string, path: string, token: string, ref?: string): Promise<string[]>;
  /** File paths below a directory, relative to it. */
  tree(repo: string, path: string, token: string, ref?: string): Promise<string[]>;
  /** The commit a ref points at; `undefined` when it does not exist. */
  commit(repo: string, ref: string, token: string): Promise<string | undefined>;
  /** `owner/name` of every repository an installation's token can read. */
  list(
    installation: PlatformInstallation,
    token: string,
    request?: typeof fetch,
  ): Promise<string[]>;
  /** One repository as a task checks it out, at its default branch. */
  get(repo: string, token: string): Promise<NonNullable<PlatformEvent['repo']>>;
  /** Browser address of a repository folder. */
  url(repo: string, path?: string, ref?: string): string;
  /** Open pull requests, newest first. */
  pullRequests(repo: string, token: string): Promise<PullRequestSummary[]>;
  /** The pull request an event is about. */
  pullRequest(event: PlatformEvent): number | undefined;
  /** A pull request's Chat SDK thread. */
  pullRequestThread(repo: string, number: number): SerializedThread;
}

export interface Integration {
  readonly id: string;
  /** The platform's name as people write it. */
  readonly name: string;
  /** SVG artwork is static, sanitized at build time, with a 24x24 viewBox. */
  readonly brand: { color: string; icon: string; dark?: string; svg?: string };
  /** One line for lists and pickers. */
  readonly description: string;
  /** The button that installs an app, in the platform's own words. */
  readonly installLabel?: string;
  /** How people reach an installed app listening to `events`, `{handle}` standing for its handle; `here` words it for the app's own page or DM. */
  readonly use?: string | ((events: string[], here?: boolean) => string | undefined);
  /** Every prompt waits for its own answer, as a Linear agent session does, so notices repeat instead of going out once per thread. */
  readonly answersEveryPrompt?: true;
  /** Replies during a turn are progress; a final response must close it. */
  readonly progressReplies?: true;
  /** An outbound call proved the installation's token revoked. */
  isUninstalled?(error: unknown): boolean;
  /** What one account an installation covers is called, such as a Slack workspace of an org install. */
  readonly covered?: string;
  /** Apps may live under an organization instead of the creator's own account. */
  readonly organizationApps?: boolean;
  /** Apps may be public: installable by any account, not only the one that owns them. */
  readonly publicApps?: boolean;
  /** Listed first among the platforms. */
  readonly featured?: true;
  /** How a model works with this platform and its tools, for a prompt about its events. */
  readonly prompt?: string;
  /** The most characters one posted reply may hold; a longer reply goes out as several, split between paragraphs. */
  readonly replyLimit?: number;
  readonly events: Record<string, EventSpec>;
  /** A Chat SDK thread id for sample events. */
  readonly sample?: string;
  /** The handle an app posts as, so its own comments are recognized; default is the app name. */
  author?(appName: string): string;
  readonly app: IntegrationApp;
  readonly auth: IntegrationAuth;
  readonly tools: IntegrationTools;
  readonly repos?: Repositories;
  /** Hosts a task's machine reaches for it: clones, API calls and its tool server. */
  readonly hosts: readonly string[];
  /** A webhook's target, or the answer to a handshake that names no app (Slack URL verification). */
  target(req: Request, raw: string): WebhookTarget | Response | undefined;
  /** The app's Chat SDK adapter, built per request; every secret is passed explicitly, never read from the environment. */
  adapter(ctx: AdapterContext): Promise<Adapter>;
  requestFetch?(request: typeof fetch, installation?: string): typeof fetch;
  /** The platform page of the thread or issue an event came from. */
  link?(event: PlatformEvent): string | undefined;
  /** Messages with buttons, where the platform has them. */
  readonly messages?: IntegrationMessages;
  /** Markdown that shows `markdown` collapsed under `summary`, for text-only posts; absent where the platform has none, so it shows in full. */
  collapsed?(summary: string, markdown: string): string;
  /** The event's position and messages since its last turn. */
  conversation?(event: PlatformEvent, access: ConversationAccess): Promise<ConversationFacts>;
  /** Signed webhooks the adapter does not handle (GitHub pull requests, issues, installs and pushes); `undefined` leaves it to the adapter. */
  ownEvents?(
    req: Request,
    raw: string,
    app: PlatformApp,
    credentials: unknown,
  ): OwnEvent | undefined;
  /** What core cannot read from a Chat SDK message, such as the actor's role; `undefined` drops it. */
  event?(
    type: string,
    thread: Thread,
    message: Message,
    app: PlatformApp,
  ): Pick<PlatformEvent, 'type' | 'actor' | 'promptContext'> | undefined;
}

/** What a minted token may reach: the permissions its tools need, across its whole installation. */
export interface TokenBound {
  tools?: string[];
}

export interface PullRequestSummary {
  number: number;
  title: string;
  author?: string;
  createdAt?: string;
}
