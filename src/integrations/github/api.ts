/** GitHub REST: request headers for Coder's own calls, and repository reads through the Chat SDK adapter's Octokit. */
import type { AgentEvent } from '../../agent/types';
import type { PullRequestSummary } from '../types';

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

/** The adapter's Octokit on one token; it verifies no webhook. */
async function octokit(token: string) {
  const [{ createGitHubAdapter }, { ConsoleLogger }] = await Promise.all([
    import('@chat-adapter/github'),
    import('chat'),
  ]);
  return createGitHubAdapter({
    installationToken: token,
    apiUrl: API,
    webhookVerifier: () => false,
    logger: new ConsoleLogger('error'),
  }).octokit;
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

export async function listGithubRepositories(token: string): Promise<string[]> {
  const client = await octokit(token);
  const repositories = await client.paginate(client.apps.listReposAccessibleToInstallation, {
    per_page: 100,
  });
  return repositories.map(entry => entry.full_name);
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
    ref: data.default_branch,
    defaultBranch: data.default_branch,
  };
}

/** Whether a GitHub user can push to the repository. */
export async function canWriteGithub(repo: string, login: string, token: string): Promise<boolean> {
  const response = await (
    await octokit(token)
  ).repos
    .getCollaboratorPermissionLevel({ ...split(repo), username: login })
    .catch(() => undefined);
  return ['admin', 'maintain', 'write'].includes(response?.data.permission ?? '');
}

export function githubRepositoryUrl(repo: string, path?: string, ref?: string): string {
  const base = `https://github.com/${repo}`;
  return path ? `${base}/tree/${ref ?? 'HEAD'}/${path}` : base;
}
