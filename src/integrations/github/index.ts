import type { Integration } from '../types';
import {
  canWriteGithub,
  githubCommit,
  githubTree,
  githubRepository,
  githubRepositoryUrl,
  listGithubDir,
  listGithubPullRequests,
  listGithubRepositories,
  readGithubFile,
  revalidateGithubFile,
  githubMembers,
  githubTeamRepositories,
  GITHUB_MCP_SERVER_INSTALL,
  GITHUB_PRESETS,
  githubToolServer,
} from './api';
import { githubApp, githubToken, githubUserAuth } from './app';
import {
  githubAdapter,
  githubChatEvent,
  githubOwnEvents,
  githubPullRequest,
  githubTarget,
  githubThread,
  githubThreadUrl,
} from './events';

const GITHUB_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 98 96" fill="none" style="color:light-dark(#000,#fff)"><g clip-path="url(#github-mark-4)"><path d="M 41.44 69.38 C 28.81 67.85 19.91 58.76 19.91 46.99 C 19.91 42.21 21.63 37.04 24.5 33.59 C 23.26 30.43 23.45 23.73 24.88 20.96 C 28.71 20.48 33.88 22.49 36.94 25.27 C 40.58 24.12 44.41 23.54 49.1 23.54 C 53.79 23.54 57.61 24.12 61.06 25.17 C 64.03 22.49 69.29 20.48 73.12 20.96 C 74.46 23.54 74.65 30.24 73.4 33.5 C 76.47 37.13 78.09 42.01 78.09 46.99 C 78.09 58.76 69.19 67.66 56.37 69.29 C 59.62 71.39 61.82 75.99 61.82 81.25 L 61.82 91.21 C 61.82 94.08 64.22 95.7 67.09 94.55 C 84.41 87.95 98 70.63 98 49.19 C 98 22.11 75.99 0 48.9 0 C 21.82 0 0 22.11 0 49.19 C 0 70.44 13.49 88.05 31.68 94.65 C 34.26 95.61 36.75 93.88 36.75 91.3 L 36.75 83.64 C 35.41 84.22 33.69 84.6 32.16 84.6 C 25.84 84.6 22.11 81.16 19.43 74.74 C 18.38 72.16 17.23 70.63 15.03 70.34 C 13.88 70.25 13.49 69.77 13.49 69.19 C 13.49 68.04 15.41 67.18 17.32 67.18 C 20.1 67.18 22.49 68.91 24.98 72.45 C 26.89 75.22 28.9 76.47 31.29 76.47 C 33.69 76.47 35.22 75.61 37.42 73.4 C 39.05 71.78 40.29 70.34 41.44 69.38 Z" fill="black" style="fill:currentColor"/></g><defs><clipPath id="github-mark-4"><rect width="98" height="96" fill="white"/></clipPath></defs></svg>';

/** The simple-icons mark, inlined since that package's index loads every icon. */
const GITHUB_ICON =
  'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12';

export const github: Integration = {
  id: 'github',
  brand: { color: '#000000', icon: GITHUB_ICON, dark: '#fff', svg: GITHUB_MARK },
  name: 'GitHub',
  featured: true,
  description: 'Pull requests, issues, and comments on GitHub repositories',
  installLabel: 'Connect GitHub',
  use: 'Mention @{handle} in an issue or pull request.',
  organizationApps: true,
  publicApps: true,
  prompt: [
    'A conversation is an issue or pull request with its comments, or one inline review thread.',
    'issue_read reads an issue with its comments. pull_request_read reads a pull request: get, get_diff, get_files, get_comments, get_reviews, get_review_comments.',
    "The repository is checked out on its default branch. Push to a pull request's branch only when it lives in this repository and changes were asked for; fork pull requests get reads and comments only.",
    'Replies are GitHub Markdown; cite file paths; link a pull request after changing it.',
    'The review tool posts findings as inline review comments marked coder-review:fp.',
  ].join('\n'),
  reach: account => `GitHub, repositories under ${account}`,
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
      description: 'New non-agent issue, pull request, or inline review comment.',
      on: 'message',
      noisy: true,
    },
  },
  tools: {
    presets: GITHUB_PRESETS,
    server: githubToolServer,
    install: GITHUB_MCP_SERVER_INSTALL,
    installHosts: ['github.com', 'release-assets.githubusercontent.com'],
  },
  hosts: ['github.com', 'api.github.com', 'codeload.github.com'],
  collapsed: (summary, markdown) =>
    `<details><summary>${summary}</summary>\n\n${markdown}\n\n</details>`,
  get app() {
    return githubApp;
  },
  auth: {
    token: githubToken,
    get user() {
      return githubUserAuth;
    },
    canWrite: async (event, token, request) =>
      Boolean(event.repo && event.actor.login) &&
      canWriteGithub(
        `${event.repo!.owner}/${event.repo!.name}`,
        event.actor.login!,
        token,
        request,
      ),
    members: (space, token, request, linked) => githubMembers(space.id, token, request, linked),
    teamSpaces: githubTeamRepositories,
  },
  repos: {
    cloneHosts: ['github.com'],
    credentialUsername: 'x-access-token',
    readFile: readGithubFile,
    revalidate: revalidateGithubFile,
    listDir: listGithubDir,
    tree: githubTree,
    commit: githubCommit,
    list: (_installation, token, request) => listGithubRepositories(token, request),
    get: githubRepository,
    url: githubRepositoryUrl,
    pullRequests: listGithubPullRequests,
    pullRequest: githubPullRequest,
    pullRequestThread: (repo, number) => githubThread(repo, number, true),
  },
  target: githubTarget,
  adapter: githubAdapter,
  link: githubThreadUrl,
  ownEvents: githubOwnEvents,
  event: githubChatEvent,
};
