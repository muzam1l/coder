import { createHmac } from 'node:crypto';

import { safeEqual } from '../../utils/crypto';
import type { SerializedThread } from 'chat';

import type { AgentApp, AgentEvent, Installation } from '../../agent/types';
import type { Integration, TokenBound } from '../types';
import {
  canWriteGithub,
  githubCommit,
  githubRepository,
  githubRepositoryUrl,
  listGithubDir,
  listGithubPullRequests,
  listGithubRepositories,
  readGithubFile,
} from './api';
import { githubApp, githubAppPermissions, githubUserAuth, type GithubAppCredentials } from './app';
import { GITHUB_MCP_SERVER_INSTALL, GITHUB_PRESETS, githubToolServer } from './tools';

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
};
type Pull = {
  number?: number;
  title?: string;
  body?: string | null;
  draft?: boolean;
  user?: User;
  head?: { sha?: string };
  base?: { sha?: string };
};
type Issue = {
  number?: number;
  title?: string;
  body?: string | null;
  user?: User;
  pull_request?: unknown;
};
type Payload = {
  action?: string;
  installation?: {
    id?: number | string;
    account?: { login?: string; type?: string };
  };
  repository?: Repo;
  pull_request?: Pull;
  requested_reviewer?: User;
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
  app: AgentApp,
  payload: Payload,
  type: string,
  input: {
    user?: User;
    body?: string;
    number?: number;
    kind?: 'pull' | 'issue';
    headSha?: string;
  },
): AgentEvent | undefined {
  const id = payload.installation?.id;
  const repo = checkout(payload, input.headSha);
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
    repo,
    chat: {
      thread: githubThread(`${repo.owner}/${repo.name}`, input.number, input.kind === 'pull'),
    },
  };
}

/** The payload's repository as a task checks it out, at `ref` or its default branch. */
function checkout(payload: Payload, ref?: string): NonNullable<AgentEvent['repo']> | undefined {
  const repo = payload.repository;
  return repo?.owner?.login && repo.name && repo.clone_url && repo.default_branch
    ? {
        owner: repo.owner.login,
        name: repo.name,
        cloneUrl: repo.clone_url,
        ref: ref ?? repo.default_branch,
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
export function parseGithubEvent(
  req: Request,
  body: unknown,
  app: AgentApp,
  credentials: Pick<GithubAppCredentials, 'slug'>,
): AgentEvent[] {
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
      !pr.head?.sha ||
      !pr.base?.sha
    )
      return [];
    const parsed = event(req, app, payload, 'pull_request', {
      user: payload.sender ?? pr.user,
      body: text(pr.title, pr.body),
      number: pr.number,
      kind: 'pull',
      headSha: pr.head.sha,
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
    });
    return parsed ? [parsed] : [];
  }
  return [];
}

/** An installation token narrowed to `scope`, minted with the app's key through the GitHub adapter's own auth library. */
export async function installationToken(
  config: { appId: string; privateKey: string },
  installationId: string | number,
  scope: { repositories?: string[]; permissions?: Record<string, string> } = {},
): Promise<string> {
  const { createAppAuth } = await import('@octokit/auth-app');
  const { token } = await createAppAuth(config)({
    type: 'installation',
    installationId,
    ...(scope.repositories ? { repositoryNames: scope.repositories } : {}),
    ...(scope.permissions ? { permissions: scope.permissions } : {}),
  });
  return token;
}
const LIFECYCLE: Record<string, string[]> = {
  installation: ['created', 'deleted', 'suspend', 'unsuspend'],
  installation_repositories: ['added', 'removed'],
};

/** An `installation` or `installation_repositories` webhook, by its `X-GitHub-Event` name and action. */
export function githubInstallation(
  name: string | null,
  body: unknown,
  app: AgentApp,
): { op: 'upsert' | 'delete'; installation: Installation } | undefined {
  const payload = value(body);
  const id = payload.installation?.id;
  const action = payload.action;
  if (id === undefined || !LIFECYCLE[name ?? '']?.includes(action ?? '')) return;
  const account = payload.installation?.account;
  const now = Date.now();
  const gone = action === 'deleted' || action === 'suspend';
  return {
    op: gone ? 'delete' : 'upsert',
    installation: {
      integration: 'github',
      id: `${app.id}:${id}`,
      app: app.id,
      account: {
        login: account?.login ?? payload.repository?.owner?.login ?? 'unknown',
        ...(account?.type ? { type: account.type } : {}),
      },
      createdAt: now,
      ...(gone ? { deletedAt: now } : {}),
    },
  };
}

export function githubChanges(
  body: unknown,
  app: AgentApp,
): { repo: string; ref: string; branch: string; paths?: string[] } | undefined {
  const payload = value(body);
  const repo = payload.repository?.full_name;
  const branch = app.branch ?? payload.repository?.default_branch;
  if (
    !repo ||
    repo !== app.agentsRepo ||
    !branch ||
    payload.ref !== `refs/heads/${branch}` ||
    !payload.after ||
    !payload.commits
  )
    return undefined;
  const paths = [
    ...new Set(
      payload.commits.flatMap(commit => [
        ...(commit.added ?? []),
        ...(commit.modified ?? []),
        ...(commit.removed ?? []),
      ]),
    ),
  ].filter(file => file.startsWith('.coder/agents/'));
  return paths.length ? { repo, ref: payload.after, branch, paths } : undefined;
}
/** The narrowest token for a bound: its repository, and the permissions its tools need. */
export function githubTokenScope(bound: TokenBound = {}): {
  repositories?: string[];
  permissions?: Record<string, string>;
} {
  return {
    ...(bound.repo ? { repositories: [bound.repo.name] } : {}),
    ...(bound.tools ? { permissions: githubAppPermissions(bound.tools) } : {}),
  };
}
const GITHUB_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 98 96" fill="none" style="color:light-dark(#000,#fff)"><g clip-path="url(#github-mark-4)"><path d="M 41.44 69.38 C 28.81 67.85 19.91 58.76 19.91 46.99 C 19.91 42.21 21.63 37.04 24.5 33.59 C 23.26 30.43 23.45 23.73 24.88 20.96 C 28.71 20.48 33.88 22.49 36.94 25.27 C 40.58 24.12 44.41 23.54 49.1 23.54 C 53.79 23.54 57.61 24.12 61.06 25.17 C 64.03 22.49 69.29 20.48 73.12 20.96 C 74.46 23.54 74.65 30.24 73.4 33.5 C 76.47 37.13 78.09 42.01 78.09 46.99 C 78.09 58.76 69.19 67.66 56.37 69.29 C 59.62 71.39 61.82 75.99 61.82 81.25 L 61.82 91.21 C 61.82 94.08 64.22 95.7 67.09 94.55 C 84.41 87.95 98 70.63 98 49.19 C 98 22.11 75.99 0 48.9 0 C 21.82 0 0 22.11 0 49.19 C 0 70.44 13.49 88.05 31.68 94.65 C 34.26 95.61 36.75 93.88 36.75 91.3 L 36.75 83.64 C 35.41 84.22 33.69 84.6 32.16 84.6 C 25.84 84.6 22.11 81.16 19.43 74.74 C 18.38 72.16 17.23 70.63 15.03 70.34 C 13.88 70.25 13.49 69.77 13.49 69.19 C 13.49 68.04 15.41 67.18 17.32 67.18 C 20.1 67.18 22.49 68.91 24.98 72.45 C 26.89 75.22 28.9 76.47 31.29 76.47 C 33.69 76.47 35.22 75.61 37.42 73.4 C 39.05 71.78 40.29 70.34 41.44 69.38 Z" fill="black" style="fill:currentColor"/></g><defs><clipPath id="github-mark-4"><rect width="98" height="96" fill="white"/></clipPath></defs></svg>';

/** The simple-icons mark, inlined since that package's index loads every icon. */
const GITHUB_ICON =
  'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12';

export const github: Integration = {
  id: 'github',
  brand: { color: '#000000', icon: GITHUB_ICON, dark: '#fff', svg: GITHUB_MARK },
  name: 'GitHub',
  description: 'Pull requests, issues, and comments on GitHub repositories',
  installLabel: 'Connect GitHub',
  organizationApps: true,
  hint: 'Cite repository file paths when discussing code. After making changes, link the pull request.',
  sample: 'github:owner/repo:1',
  author: name => `${name}[bot]`,
  events: {
    mention: {
      description:
        'Comment from a repo owner or org member mentioning @<agent>; text has the mention stripped.',
      on: 'mention',
      addressed: true,
    },
    pull_request: { description: 'Opened, updated, or ready non-draft pull request.' },
    issue: { description: 'Opened or edited issue.' },
    comment: {
      description: 'New non-agent issue or pull-request comment.',
      on: 'message',
      noisy: true,
    },
  },
  tools: {
    presets: GITHUB_PRESETS,
    server: githubToolServer,
    install: GITHUB_MCP_SERVER_INSTALL,
  },
  get app() {
    return githubApp;
  },
  auth: {
    // Installation store ids are `<app id>:<platform installation id>`.
    token: (installation, credentials, bound) =>
      installationToken(
        credentials as GithubAppCredentials,
        installation.id.split(':').pop()!,
        githubTokenScope(bound),
      ),
    get user() {
      return githubUserAuth;
    },
    canWrite: async (event, token) =>
      Boolean(event.repo && event.actor.login) &&
      canWriteGithub(`${event.repo!.owner}/${event.repo!.name}`, event.actor.login!, token),
  },
  repos: {
    cloneHosts: ['github.com'],
    readFile: readGithubFile,
    listDir: listGithubDir,
    commit: githubCommit,
    list: (_installation, token) => listGithubRepositories(token),
    get: githubRepository,
    url: githubRepositoryUrl,
    pullRequests: listGithubPullRequests,
    pullRequest: event => {
      const pull = /^github:[^:]+:(\d+)(?::|$)/.exec(event.chat?.thread.id ?? '');
      return pull ? Number(pull[1]) : undefined;
    },
    pullRequestThread: (repo, number) => githubThread(repo, number, true),
  },
  target(req, raw) {
    const app = req.headers.get('x-github-hook-installation-target-id');
    if (!app) return undefined;
    const payload = value(json(raw));
    const repo = checkout(payload);
    return {
      app,
      ...(payload.installation?.id !== undefined
        ? { installation: String(payload.installation.id) }
        : {}),
      ...(repo ? { repo } : {}),
    };
  },
  adapter: async ctx => (await import('./adapter')).githubAdapter(ctx),
  ownEvents(req, raw, app, credentials) {
    const name = req.headers.get('x-github-event');
    if (!name || ADAPTER_EVENTS.includes(name)) return undefined;
    const { webhookSecret, slug } = credentials as GithubAppCredentials;
    if (!verifyGithubWebhook(raw, req.headers.get('x-hub-signature-256'), webhookSecret))
      return { invalid: true };
    const body = json(raw);
    const installation = githubInstallation(name, body, app);
    if (installation) return { installation };
    const changes = githubChanges(body, app);
    if (changes) return { changes };
    return { events: parseGithubEvent(req, body, app, { slug }) };
  },
  event(type, _thread, message) {
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
  },
};
