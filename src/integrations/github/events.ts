/** Comments come through the Chat SDK adapter, loaded on first use; every other webhook is verified and parsed here. */
import { createHmac } from 'node:crypto';

import { safeEqual } from '../../utils/crypto';
import type { Adapter, Message, SerializedThread, Thread } from 'chat';

import type {
  AdapterContext,
  Space,
  OwnEvent,
  PlatformApp,
  PlatformEvent,
  PlatformInstallation,
  MembersChange,
  Push,
  SpaceChange,
  WebhookTarget,
} from '../types';
import { GITHUB_PRESETS, routed } from './api';
import type { GithubAppCredentials } from './app';

type User = {
  id?: number | string;
  login?: string;
  type?: string;
  agent?: boolean;
  author_association?: string;
};
type Repo = {
  full_name?: string;
  name?: string;
  owner?: { login?: string };
  clone_url?: string;
  default_branch?: string;
  private?: boolean;
};
type Pull = {
  number?: number;
  title?: string;
  body?: string | null;
  draft?: boolean;
  user?: User;
  head?: { repo?: { full_name?: string } | null };
};
type Issue = {
  number?: number;
  title?: string;
  body?: string | null;
  user?: User;
  pull_request?: unknown;
  comments?: number;
};
type Payload = {
  action?: string;
  installation?: {
    id?: number | string;
    account?: { login?: string; type?: string };
  };
  repositories?: Repo[];
  repositories_added?: Repo[];
  repositories_removed?: Repo[];
  changes?: { repository?: { name?: { from?: string } } };
  repository_selection?: 'all' | 'selected';
  repository?: Repo;
  pull_request?: Pull;
  requested_reviewer?: User;
  member?: User | null;
  scope?: string;
  team?: { slug?: string };
  organization?: { login?: string };
  issue?: Issue;
  sender?: User;
  ref?: string;
  after?: string;
  commits?: Array<{
    added?: string[];
    modified?: string[];
    removed?: string[];
  }>;
};
function value(body: unknown): Payload {
  return body && typeof body === 'object' ? (body as Payload) : {};
}
function agent(user?: User): boolean {
  return user?.agent === true || user?.type === 'Bot' || user?.login?.endsWith('[bot]') === true;
}
function text(title?: string, body?: string | null): string {
  return [title, body].filter((part): part is string => Boolean(part)).join('\n\n');
}
/** Whether `text` @-mentions the app by its slug. */
const mentions = (text: string, slug: string) =>
  new RegExp(`(^|[^\\w-])@${slug}(?![\\w-])`, 'i').test(text);
const MAINTAINERS = ['OWNER', 'MEMBER'];
/** Webhooks the Chat SDK adapter verifies and handles. */
const ADAPTER_EVENTS = ['issue_comment', 'pull_request_review_comment', 'ping'];

function json(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
export function verifyGithubWebhook(
  raw: string,
  signature: string | null,
  secret: string | undefined,
): boolean {
  if (!secret || !signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'), 'hex');
  return safeEqual(Buffer.from(signature.slice(7), 'hex'), expected);
}
function event(
  req: Request,
  app: PlatformApp,
  payload: Payload,
  type: string,
  input: {
    user?: User;
    body?: string;
    number?: number;
    kind?: 'pull' | 'issue';
    slug: string;
  },
): PlatformEvent | undefined {
  const id = payload.installation?.id;
  const repo = checkout(payload);
  const user = input.user ?? payload.sender;
  if (id === undefined || !repo || !input.number) return;
  const role = user?.author_association;
  return {
    integration: 'github',
    type,
    appId: app.id,
    installationId: String(id),
    deliveryId: req.headers.get('x-github-delivery') ?? '',
    actor: {
      id: String(user?.id ?? user?.login ?? ''),
      ...(user?.login ? { login: user.login } : {}),
      ...(role ? { role } : {}),
      ...(agent(user) ? { agent: true } : {}),
    },
    text: input.body ?? '',
    ...(mentions(input.body ?? '', input.slug) ? { mentioned: true as const } : {}),
    repo,
    space: repoSpace(payload)!,
    chat: {
      thread: githubThread(`${repo.owner}/${repo.name}`, input.number, input.kind === 'pull'),
    },
  };
}

/** The payload's repository as a space, private as its `private` field says. */
function repoSpace(payload: Payload): Space | undefined {
  const repo = payload.repository;
  if (!repo?.owner?.login || !repo.name) return undefined;

  return {
    kind: 'repository',
    id: `${repo.owner.login}/${repo.name}`,
    ...(typeof repo.private === 'boolean' ? { private: repo.private } : {}),
  };
}

/** A repository made private or public (`repository` `privatized`, `publicized`). */
function repositoryPrivacy(body: unknown): SpaceChange | undefined {
  const payload = body as Payload;
  const space = repoSpace(payload);
  const installation = payload.installation?.id;
  if (!space || installation === undefined) return undefined;
  if (payload.action !== 'privatized' && payload.action !== 'publicized') return undefined;

  return {
    installation: String(installation),
    space: { ...space, private: payload.action === 'privatized' },
  };
}

/** A collaborator added, edited or removed (`member`): the repository's list takes or drops them at once. */
function collaboratorChange(body: unknown): SpaceChange | undefined {
  const payload = value(body);
  const space = repoSpace(payload);
  const installation = payload.installation?.id;
  const member = payload.member?.id;
  if (!space || installation === undefined || member === undefined) return undefined;
  if (!['added', 'edited', 'removed'].includes(payload.action ?? '')) return undefined;

  return {
    installation: String(installation),
    // The payload's privacy is not a change of it.
    space: { kind: space.kind, id: space.id },
    ...(payload.action === 'removed' ? { left: String(member) } : { joined: String(member) }),
  };
}

/** The stored lists to fetch again after a team or organization membership webhook (`membership`, `team`, `organization`). */
function membershipChange(name: string, body: unknown): MembersChange | undefined {
  const payload = value(body);
  const installation = payload.installation?.id;
  const org = payload.organization?.login;
  if (installation === undefined || !org) return undefined;
  const id = String(installation);
  const team = payload.team?.slug ? `${org}/${payload.team.slug}` : undefined;
  const repo = payload.repository?.full_name;
  const action = payload.action ?? '';

  if (name === 'membership' && payload.scope === 'team' && team) return { installation: id, team };
  if (name === 'team' && ['added_to_repository', 'removed_from_repository'].includes(action)) {
    if (repo) return { installation: id, spaces: [repo] };
    return team ? { installation: id, team } : undefined;
  }
  // A deleted team's repositories can no longer be listed.
  if (name === 'team' && action === 'deleted') return { installation: id };
  if (name === 'organization' && ['member_added', 'member_removed'].includes(action))
    return { installation: id };
  return undefined;
}

/** The payload's repository as a task checks it out, at its default branch. */
function checkout(payload: Payload): NonNullable<PlatformEvent['repo']> | undefined {
  const repo = payload.repository;
  return repo?.owner?.login && repo.name && repo.clone_url && repo.default_branch
    ? {
        owner: repo.owner.login,
        name: repo.name,
        cloneUrl: repo.clone_url,
        defaultBranch: repo.default_branch,
      }
    : undefined;
}

/** A pull request's or issue's Chat SDK thread, in the GitHub adapter's id format. */
export function githubThread(repo: string, number: number, pull: boolean): SerializedThread {
  return {
    _type: 'chat:Thread',
    adapterName: 'github',
    channelId: `github:${repo}`,
    id: `github:${repo}:${pull ? '' : 'issue:'}${number}`,
    isDM: false,
  };
}
/** Pull request and issue webhooks as events; comments go through the Chat SDK adapter. */
function parseGithubEvent(
  req: Request,
  body: unknown,
  app: PlatformApp,
  credentials: Pick<GithubAppCredentials, 'slug'>,
): PlatformEvent[] {
  const payload = value(body);
  const name = req.headers.get('x-github-event');
  if (name === 'pull_request') {
    const pr = payload.pull_request;
    const action = payload.action ?? '';
    const requested = payload.requested_reviewer?.login?.toLowerCase();
    if (
      !pr ||
      !['opened', 'synchronize', 'reopened', 'ready_for_review', 'review_requested'].includes(
        action,
      ) ||
      (action === 'review_requested' && requested !== `${credentials.slug}[bot]`.toLowerCase()) ||
      pr.draft ||
      (action !== 'review_requested' && agent(pr.user)) ||
      !pr.number ||
      // A fork's pull request starts nothing.
      pr.head?.repo?.full_name !== payload.repository?.full_name
    )
      return [];
    const parsed = event(req, app, payload, 'pull_request', {
      user: payload.sender ?? pr.user,
      body: text(pr.title, pr.body),
      number: pr.number,
      kind: 'pull',
      slug: credentials.slug,
    });
    return parsed ? [parsed] : [];
  }
  if (name === 'issues') {
    const issue = payload.issue;
    if (
      !issue ||
      !['opened', 'edited'].includes(payload.action ?? '') ||
      agent(payload.sender ?? issue.user) ||
      !issue.number
    )
      return [];
    const parsed = event(req, app, payload, 'issue', {
      user: payload.sender ?? issue.user,
      body: text(issue.title, issue.body),
      number: issue.number,
      slug: credentials.slug,
    });
    return parsed ? [parsed] : [];
  }
  return [];
}

const LIFECYCLE: Record<string, string[]> = {
  installation: ['created', 'deleted', 'suspend', 'unsuspend', 'new_permissions_accepted'],
  installation_repositories: ['added', 'removed'],
  repository: ['created', 'deleted', 'renamed'],
};

/** An `installation` or `installation_repositories` webhook, by its `X-GitHub-Event` name and action. */
export function githubInstallation(
  name: string | null,
  body: unknown,
  app: PlatformApp,
):
  | {
      op: 'upsert' | 'delete';
      installation: PlatformInstallation;
      repos?: { add: string[]; remove: string[]; refresh?: true };
    }
  | undefined {
  const payload = value(body);
  const id = payload.installation?.id;
  const action = payload.action;
  if (id === undefined || !LIFECYCLE[name ?? '']?.includes(action ?? '')) return;
  const account = payload.installation?.account;
  const now = Date.now();
  const gone = name === 'installation' && (action === 'deleted' || action === 'suspend');
  return {
    op: gone ? 'delete' : 'upsert',
    ...(name === 'repository' && payload.repository?.full_name
      ? {
          repos: {
            add: action === 'created' || action === 'renamed' ? [payload.repository.full_name] : [],
            remove:
              action === 'deleted'
                ? [payload.repository.full_name]
                : action === 'renamed' && payload.changes?.repository?.name?.from
                  ? [
                      `${payload.repository.full_name.split('/')[0]}/${payload.changes.repository.name.from}`,
                    ]
                  : [],
          },
        }
      : {}),
    ...(name === 'installation_repositories'
      ? {
          repos: {
            ...(payload.repository_selection &&
            (action === 'removed'
              ? !payload.repositories_removed?.length
              : !payload.repositories_added?.length)
              ? { refresh: true as const }
              : {}),
            add: (payload.repositories_added ?? []).flatMap(repo =>
              repo.full_name ? [repo.full_name] : [],
            ),
            remove: (payload.repositories_removed ?? []).flatMap(repo =>
              repo.full_name ? [repo.full_name] : [],
            ),
          },
        }
      : {}),
    installation: {
      integration: 'github',
      ...(name === 'installation' && action === 'deleted' ? { uninstalled: true } : {}),
      id: `${app.id}:${id}`,
      app: app.id,
      account: {
        login: account?.login ?? payload.repository?.owner?.login ?? 'unknown',
        ...(account?.type ? { type: account.type } : {}),
      },
      createdAt: now,
      ...(payload.repositories
        ? { repos: payload.repositories.flatMap(repo => (repo.full_name ? [repo.full_name] : [])) }
        : {}),
      ...(gone ? { deletedAt: now } : {}),
    },
  };
}

/** A push to a branch, with every path its listed commits touched; GitHub lists at most 2048 commits. */
export function githubPush(body: unknown, app: PlatformApp): Push | undefined {
  const payload = value(body);
  const repo = payload.repository?.full_name;
  const branch = payload.ref?.startsWith('refs/heads/') && payload.ref.slice('refs/heads/'.length);
  if (!repo || !branch) return undefined;
  const id = payload.installation?.id;
  const commits = payload.commits ?? [];
  const paths = commits.flatMap(commit => [
    ...(commit.added ?? []),
    ...(commit.modified ?? []),
    ...(commit.removed ?? []),
  ]);

  return {
    ...(id !== undefined ? { installation: `${app.id}:${id}` } : {}),
    repo,
    branch,
    ...(payload.after ? { commit: payload.after } : {}),
    ...(payload.repository?.default_branch
      ? { defaultBranch: payload.repository.default_branch }
      : {}),
    paths: [...new Set(paths)],
    ...(!commits.length || commits.length >= 2048 ? { partial: true as const } : {}),
  };
}

export function githubTarget(req: Request, raw: string): WebhookTarget | undefined {
  const app = req.headers.get('x-github-hook-installation-target-id');
  if (!app) return undefined;
  const payload = value(json(raw)) as Payload & { comment?: { in_reply_to_id?: number } };
  const repo = checkout(payload);
  const space = repoSpace(payload);
  // A comment's position is the conversation's comment count; a review thread knows only that its finding is the root.
  const index = payload.issue
    ? payload.issue.comments
    : payload.comment && payload.comment.in_reply_to_id === undefined
      ? 0
      : undefined;
  return {
    app,
    ...(payload.installation?.id !== undefined
      ? { installation: String(payload.installation.id) }
      : {}),
    ...(repo ? { repo } : {}),
    ...(space ? { space } : {}),
    ...(index !== undefined ? { index } : {}),
  };
}

export function githubOwnEvents(
  req: Request,
  raw: string,
  app: PlatformApp,
  credentials: unknown,
): OwnEvent | undefined {
  const name = req.headers.get('x-github-event');
  if (!name || ADAPTER_EVENTS.includes(name)) return undefined;
  const { webhookSecret, slug } = credentials as GithubAppCredentials;
  if (!verifyGithubWebhook(raw, req.headers.get('x-hub-signature-256'), webhookSecret))
    return { invalid: true };
  const body = json(raw);
  const changed =
    name === 'repository'
      ? repositoryPrivacy(body)
      : name === 'member'
        ? collaboratorChange(body)
        : undefined;
  if (changed) return { space: changed };
  const members = membershipChange(name, body);
  if (members) return { members };
  const installation = githubInstallation(name, body, app);
  if (installation) return { installation };
  const push = name === 'push' ? githubPush(body, app) : undefined;
  if (push) return { push };
  return { events: parseGithubEvent(req, body, app, { slug }) };
}

export function githubChatEvent(
  type: string,
  _thread: Thread,
  message: Message,
): Pick<PlatformEvent, 'type' | 'actor'> {
  const role = (message.raw as { comment?: { author_association?: string } }).comment
    ?.author_association;
  return {
    // Only the repository's owners and members address the agent directly.
    type: type === 'mention' && !MAINTAINERS.includes(role ?? '') ? 'comment' : type,
    actor: {
      id: message.author.userId,
      login: message.author.userName,
      ...(role ? { role } : {}),
    },
  };
}

/** The issue, pull request or review thread page of an event's Chat SDK thread. */
export function githubThreadUrl(event: PlatformEvent): string | undefined {
  const thread = /^github:([^:]+):(issue:)?(\d+)(?::rc:(\d+))?(?::|$)/.exec(
    event.chat?.thread.id ?? '',
  );
  return thread
    ? `https://github.com/${thread[1]}/${thread[2] ? 'issues' : 'pull'}/${thread[3]}${thread[4] ? `#discussion_r${thread[4]}` : ''}`
    : undefined;
}

export function githubPullRequest(event: PlatformEvent): number | undefined {
  const pull = /^github:[^:]+:(\d+)(?::|$)/.exec(event.chat?.thread.id ?? '');
  return pull ? Number(pull[1]) : undefined;
}

/** GitHub comments through Chat SDK: the app's webhook secret verifies, the host mints the installation token. */
export async function githubAdapter(ctx: AdapterContext): Promise<Adapter> {
  const [{ createGitHubAdapter }, { ConsoleLogger }] = await Promise.all([
    import('@chat-adapter/github'),
    import('chat'),
  ]);
  const webhookSecret = (ctx.credentials as GithubAppCredentials | undefined)?.webhookSecret;
  const installationId = ctx.installationId;
  // One mint per request: the adapter asks before every API call.
  let minted: Promise<string> | undefined;
  const adapter = createGitHubAdapter({
    userName: ctx.name,
    // Set, so no GITHUB_* variable redirects the token or names a member as the app; no user has id 0.
    apiUrl: 'https://api.github.com',
    botUserId: 0,
    installationToken: () =>
      installationId
        ? (minted ??= ctx.token(installationId, { tools: GITHUB_PRESETS['read-only'] }))
        : Promise.reject(new Error('The webhook names no GitHub installation')),
    // Without the app's secret (a task's runner, which only posts) no webhook is ever accepted.
    webhookVerifier: (req, body) =>
      verifyGithubWebhook(body, req.headers.get('x-hub-signature-256'), webhookSecret),
    logger: new ConsoleLogger('error'),
  });
  routed(adapter.octokit, ctx.fetch);

  return adapter;
}
