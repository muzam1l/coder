/** GitHub REST: request headers for Coder's own calls, and repository reads through the Chat SDK adapter's Octokit. */
import type { AgentEvent, PullRequestSummary } from '../types';

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
): Promise<NonNullable<AgentEvent['repo']>> {
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

export function githubRepositoryUrl(repo: string, path?: string, ref?: string): string {
  const base = `https://github.com/${repo}`;
  return path ? `${base}/tree/${ref ?? 'HEAD'}/${path}` : base;
}
