/** Direct REST calls send `githubHeaders`; repository reads go through the Chat SDK adapter's Octokit, loaded on first use. */
import type { Access, LinkedMember, PlatformEvent, PullRequestSummary, ToolServer } from '../types';

export const API = 'https://api.github.com';

export type Fetcher = typeof fetch;

export function githubHeaders(
  token?: string,
  accept = 'application/vnd.github+json',
): Record<string, string> {
  return {
    accept,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    'user-agent': 'coder',
    'x-github-api-version': '2022-11-28',
  };
}

type Octokit = import('@chat-adapter/github').GitHubAdapter['octokit'];

/** Sends every call of `client` through `request`. */
export function routed(client: Octokit, request: Fetcher): Octokit {
  client.hook.before('request', options => {
    options.request = { ...options.request, fetch: request };
  });
  return client;
}

/** The adapter's Octokit on one token, or on the app's key to mint one; it verifies no webhook. */
export async function octokit(
  auth: string | { appId: string; privateKey: string; installationId: number },
  request: Fetcher = fetch,
): Promise<Octokit> {
  const [{ createGitHubAdapter }, { ConsoleLogger }] = await Promise.all([
    import('@chat-adapter/github'),
    import('chat'),
  ]);
  const adapter = createGitHubAdapter({
    ...(typeof auth === 'string' ? { installationToken: auth } : auth),
    apiUrl: API,
    webhookVerifier: () => false,
    logger: new ConsoleLogger('error'),
  });
  return routed(adapter.octokit, request);
}

/** `undefined` for a missing file or ref, any other failure thrown. */
const missing = (codes: number[]) => (error: { status?: number }) => {
  if (codes.includes(error.status ?? 0)) return undefined;
  throw error;
};

const split = (repo: string) => {
  const [owner = '', name = ''] = repo.split('/');
  return { owner, repo: name };
};

export async function readGithubFile(
  repo: string,
  path: string,
  token: string,
  ref?: string,
): Promise<string | undefined> {
  const response = await (
    await octokit(token)
  ).repos
    .getContent({ ...split(repo), path, ...(ref ? { ref } : {}), mediaType: { format: 'raw' } })
    .catch(missing([404]));
  // A directory answers with its listing.
  return typeof response?.data === 'string' ? response.data : undefined;
}

export async function revalidateGithubFile(
  repo: string,
  path: string,
  token: string,
  input: { ref?: string; etag?: string; fetch: Fetcher },
): Promise<'unchanged' | { text?: string; etag?: string }> {
  const url = new URL(`${API}/repos/${repo}/contents/${path}`);
  if (input.ref) url.searchParams.set('ref', input.ref);
  const response = await input.fetch(url, {
    headers: { ...githubHeaders(token), ...(input.etag ? { 'if-none-match': input.etag } : {}) },
  });
  if (response.status === 304) return 'unchanged';
  const etag = response.headers.get('etag') ?? undefined;
  if (response.status === 404) return etag ? { etag } : {};
  if (!response.ok) throw new Error(`GitHub answered ${response.status} reading ${repo}/${path}`);

  const body = (await response.json()) as { type?: string; encoding?: string; content?: string };
  // A directory answers with its listing.
  const text =
    body.type === 'file' && body.encoding === 'base64'
      ? Buffer.from(body.content ?? '', 'base64').toString()
      : undefined;
  return { ...(text === undefined ? {} : { text }), ...(etag ? { etag } : {}) };
}

export async function githubCommit(
  repo: string,
  ref: string,
  token: string,
): Promise<string | undefined> {
  const response = await (
    await octokit(token)
  ).repos
    .getCommit({ ...split(repo), ref, mediaType: { format: 'sha' } })
    .catch(missing([404, 422]));
  return response ? String(response.data).trim() : undefined;
}

/** GitHub credits a commit to an account by its `<id>+<login>@users.noreply.github.com` email. */
export async function githubCommitAuthor(
  account: { login?: string; id?: string | number },
  token: string,
  request: Fetcher = fetch,
): Promise<{ name: string; email: string; id: number }> {
  let { login, id } = account;
  if (!login || id === undefined) {
    const api = await octokit(token, request);
    ({ login, id } = login
      ? (await api.users.getByUsername({ username: login })).data
      : (await api.users.getAuthenticated()).data);
  }

  return { name: login, email: `${id}+${login}@users.noreply.github.com`, id: Number(id) };
}

export async function githubTree(
  repo: string,
  path: string,
  token: string,
  ref = 'HEAD',
): Promise<string[]> {
  const api = await octokit(token);
  const input = split(repo);
  const prefix = `${path}/`;
  const result = await api.git
    .getTree({ ...input, tree_sha: ref, recursive: '1' })
    .catch(missing([404]));
  if (!result) return [];
  const files: string[] = [];
  const keep = (name: string) =>
    name.startsWith(prefix) && name.slice(prefix.length).split('/').length <= 22;
  if (!result.data.truncated)
    return result.data.tree.flatMap(entry =>
      entry.type === 'blob' && entry.path && keep(entry.path)
        ? [entry.path.slice(prefix.length)]
        : [],
    );
  const walk = async (sha: string, parent = ''): Promise<void> => {
    const { data } = await api.git.getTree({ ...input, tree_sha: sha });
    await Promise.all(
      data.tree.map(async entry => {
        const name = parent ? `${parent}/${entry.path}` : entry.path;
        if (!name) return;
        if (entry.type === 'blob' && keep(name)) files.push(name.slice(prefix.length));
        else if (
          entry.type === 'tree' &&
          entry.sha &&
          (prefix.startsWith(`${name}/`) || (name.startsWith(prefix) && keep(name)))
        )
          await walk(entry.sha, name);
      }),
    );
  };
  await walk(ref);

  return files.sort();
}

export async function listGithubDir(
  repo: string,
  path: string,
  token: string,
  ref?: string,
): Promise<string[]> {
  const response = await (
    await octokit(token)
  ).repos
    .getContent({ ...split(repo), path, ...(ref ? { ref } : {}) })
    .catch(missing([404]));
  return Array.isArray(response?.data) ? response.data.map(entry => entry.name) : [];
}

export async function listGithubRepositories(
  token: string,
  request: Fetcher = fetch,
): Promise<string[]> {
  const repositories: string[] = [];
  for (let page = 1; ; page++) {
    const response = await request(`${API}/installation/repositories?per_page=100&page=${page}`, {
      headers: { ...githubHeaders(token), authorization: `token ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub repositories failed: ${response.status}`);
    const body = (await response.json()) as {
      total_count: number;
      repositories: Array<{ full_name: string }>;
    };
    repositories.push(...body.repositories.map(repo => repo.full_name));
    if (repositories.length >= body.total_count || body.repositories.length < 100) break;
  }

  return [...new Set(repositories)];
}

export async function listGithubPullRequests(
  repo: string,
  token: string,
): Promise<PullRequestSummary[]> {
  const { data } = await (
    await octokit(token)
  ).pulls.list({ ...split(repo), state: 'open', sort: 'created', direction: 'desc', per_page: 50 });
  return data.map(pull => ({
    number: pull.number,
    title: pull.title,
    author: pull.user?.login,
    createdAt: pull.created_at,
  }));
}

export async function githubRepository(
  repo: string,
  token: string,
): Promise<NonNullable<PlatformEvent['repo']>> {
  const { data } = await (await octokit(token)).repos.get(split(repo));
  return {
    owner: data.owner.login,
    name: data.name,
    cloneUrl: data.clone_url,
    defaultBranch: data.default_branch,
  };
}

/** Whether a GitHub user can push to the repository. */
export async function canWriteGithub(
  repo: string,
  login: string,
  token: string,
  request?: Fetcher,
): Promise<boolean> {
  const response = await (
    await octokit(token, request)
  ).repos
    .getCollaboratorPermissionLevel({ ...split(repo), username: login })
    .catch(() => undefined);
  return ['admin', 'maintain', 'write'].includes(response?.data.permission ?? '');
}

/** The user ids of everyone with access to a repository: collaborators, and organization members through teams, base permissions or ownership (`GET /repos/{owner}/{repo}/collaborators`, Metadata read). Refused that list, it checks each of the `linked` members instead. */
export async function githubMembers(
  repo: string,
  token: string,
  request?: Fetcher,
  linked?: () => Promise<LinkedMember[]>,
): Promise<string[]> {
  const client = await octokit(token, request);
  const people = await client
    .paginate(client.repos.listCollaborators, { ...split(repo), affiliation: 'all', per_page: 100 })
    .catch(error => {
      if ((error as { status?: number }).status !== 403 || !linked) throw error;
    });
  if (people) return people.map(person => String(person.id));

  // The list needs write access; a user's permission is readable without it. A link made before logins were stored looks its login up.
  const members: string[] = [];
  for (const { id, login } of await linked!()) {
    const username =
      login ??
      (
        await client
          .request('GET /user/{account_id}', { account_id: Number(id) })
          .catch(missing([404]))
      )?.data.login;
    const permission =
      username &&
      (await client.repos
        .getCollaboratorPermissionLevel({ ...split(repo), username })
        .catch(missing([404])));
    // A stored login may since belong to another account.
    if (
      permission &&
      permission.data.permission !== 'none' &&
      String(permission.data.user?.id) === id
    )
      members.push(id);
  }

  return members;
}

/** `owner/name` of every repository a team, named `org/slug`, can reach; it needs the Members organization permission. */
export async function githubTeamRepositories(
  team: string,
  token: string,
  request?: Fetcher,
): Promise<string[]> {
  const client = await octokit(token, request);
  const [org = '', slug = ''] = team.split('/');
  const repos = await client.paginate(client.teams.listReposInOrg, {
    org,
    team_slug: slug,
    per_page: 100,
  });

  return repos.map(repo => repo.full_name);
}

export function githubRepositoryUrl(repo: string, path?: string, ref?: string): string {
  const base = `https://github.com/${repo}`;
  return path ? `${base}/tree/${ref ?? 'HEAD'}/${path}` : base;
}

export const GITHUB_PRESETS: Record<Access, string[]> = {
  'read-only': ['read'],
  auto: ['read', 'write'],
};

/** The latest release binary of github/github-mcp-server into /usr/local/bin. */
export const GITHUB_MCP_SERVER_INSTALL =
  'arch=$(uname -m); [ "$arch" = aarch64 ] && arch=arm64; curl -fsSL "https://github.com/github/github-mcp-server/releases/latest/download/github-mcp-server_Linux_$arch.tar.gz" | tar -xz -C /usr/local/bin github-mcp-server';

/** GitHub's official MCP server (github/github-mcp-server) on the task's narrowed installation token. */
/** What a user's own GitHub connection reaches. */
export const GITHUB_USER_DESCRIPTION =
  "On the user's token; acts as the user, in repositories both the user and this agent's GitHub App can access.";

export function githubToolServer(
  tools: string[],
  _event: PlatformEvent | undefined,
  token: string,
  owner?: string,
): ToolServer {
  const readOnly = !tools.includes('write');
  return {
    name: 'github',
    command: 'github-mcp-server',
    args: ['stdio', '--toolsets=all', ...(readOnly ? ['--read-only'] : [])],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
    description: owner
      ? GITHUB_USER_DESCRIPTION
      : 'On the installation token; the repositories the app is installed on.',
    instructions: [
      'issue_read reads an issue with its comments.',
      'pull_request_read reads a pull request: get, get_diff, get_files, get_comments, get_reviews, get_review_comments.',
    ].join(' '),
  };
}
