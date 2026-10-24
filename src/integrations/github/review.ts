/** Pull request reviews over the REST API: the range to review, the author's earlier inline threads, and one review per run. */
import { execFileSync } from 'node:child_process';

import { API, githubHeaders, type Fetcher } from './api';
import type { PullRequestReviews, ReviewComment, ReviewTarget } from '../types';

// Only a marker that ends its body counts, so text quoted above it cannot plant one.
const FINGERPRINT = /<!-- coder-review:fp=([a-f0-9]{40}) -->\s*$/;
const HEAD_MARKER = /<!-- coder-review head=([a-f0-9]{40}) -->\s*$/;

interface Posted {
  id: number;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  in_reply_to_id?: number;
  body?: string | null;
  html_url?: string;
  user?: { login?: string } | null;
}

async function call<T>(
  token: string,
  path: string,
  request: Fetcher,
  init: { method?: string; body?: unknown } = {},
): Promise<{ data: T; next?: string }> {
  const response = await request(path.startsWith('https://') ? path : `${API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...githubHeaders(token),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  if (!response.ok)
    throw new Error(
      `GitHub ${init.method ?? 'GET'} ${path.replace(API, '')} failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
    );
  const next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];

  return { data: (await response.json()) as T, ...(next ? { next } : {}) };
}

async function all<T>(token: string, path: string, request: Fetcher): Promise<T[]> {
  const rows: T[] = [];
  let next: string | undefined = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  while (next) {
    const page: { data: T[]; next?: string } = await call<T[]>(token, next, request);
    rows.push(...page.data);
    next = page.next;
  }

  return rows;
}

export function parseGithubPr(
  value: number | string,
): { number: number; repo?: string } | undefined {
  if (typeof value === 'number')
    return Number.isInteger(value) && value > 0 ? { number: value } : undefined;
  if (/^\d+$/.test(value)) return { number: Number(value) };
  const match = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);

  return match ? { number: Number(match[3]), repo: `${match[1]}/${match[2]}` } : undefined;
}

function repository(cwd: string): string | undefined {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
    }).trim();

    return url
      .match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
      ?.slice(1, 3)
      .join('/');
  } catch {
    return undefined;
  }
}

/** The head marker of the author's newest review that has one. */
export function lastReviewedHead(
  reviews: Array<{ body?: string | null; user?: { login?: string } | null }>,
  author: string,
): string | undefined {
  for (const review of [...reviews].reverse())
    if (review.user?.login === author) {
      const head = review.body?.match(HEAD_MARKER)?.[1];
      if (head) return head;
    }

  return undefined;
}

/** Fingerprint to thread URL for each of `comments` that carries a marker. */
function marked(comments: Posted[]): Map<string, string> {
  const threads = new Map<string, string>();
  for (const comment of comments) {
    const fingerprint = comment.body?.match(FINGERPRINT)?.[1];
    if (fingerprint && comment.html_url) threads.set(fingerprint, comment.html_url);
  }

  return threads;
}

async function head(
  pr: { repo: string; number: number },
  token: string,
  request: Fetcher = fetch,
): Promise<string> {
  const { data } = await call<{ head: { sha: string } }>(
    token,
    `/repos/${pr.repo}/pulls/${pr.number}`,
    request,
  );

  return data.head.sha;
}

async function target(
  pr: { repo: string; number: number; author?: string },
  token: string,
  request: Fetcher = fetch,
): Promise<ReviewTarget> {
  const base = `/repos/${pr.repo}/pulls/${pr.number}`;
  const [{ data: view }, author] = await Promise.all([
    call<{ base: { sha: string }; head: { sha: string } }>(token, base, request),
    pr.author ?? call<{ login: string }>(token, '/user', request).then(user => user.data.login),
  ]);
  const since = lastReviewedHead(await all<Posted>(token, `${base}/reviews`, request), author);
  const prior: NonNullable<ReviewTarget['prior']> = [];
  try {
    const comments = await all<Posted>(token, `${base}/comments`, request);
    const own = comments.filter(
      comment => comment.user?.login === author && FINGERPRINT.test(comment.body ?? ''),
    );
    const resolved = new Set<number>();
    if (own.length)
      try {
        const [owner, name] = pr.repo.split('/');
        const { data: result } = await call<{
          data?: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: Array<{
                    isResolved: boolean;
                    comments: { nodes: Array<{ databaseId: number }> };
                  }>;
                };
              };
            };
          };
          errors?: unknown[];
        }>(token, `${API}/graphql`, request, {
          method: 'POST',
          body: {
            query:
              'query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ reviewThreads(first:100){ nodes{ isResolved comments(first:1){ nodes{ databaseId } } } } } } }',
            variables: { owner, name, number: pr.number },
          },
        });
        if (result.errors?.length || !result.data)
          throw new Error('Review thread history unavailable');
        for (const thread of result.data.repository.pullRequest.reviewThreads.nodes)
          if (thread.isResolved)
            for (const comment of thread.comments.nodes) resolved.add(comment.databaseId);
      } catch (error) {
        console.error('github: review history keeps threads unresolved', error);
      }
    for (const comment of own.sort((a, b) => b.id - a.id)) {
      const title = comment.body?.match(/^### ([^\r\n]+)/)?.[1];
      const line = comment.line ?? comment.original_line;
      if (!comment.path || !line || !title) continue;
      prior.push({
        file: comment.path,
        line,
        title,
        state: resolved.has(comment.id)
          ? 'resolved'
          : comments.some(
                reply =>
                  reply.in_reply_to_id === comment.id &&
                  reply.user?.login &&
                  reply.user.login !== author,
              )
            ? 'replied'
            : 'open',
      });
      if (prior.length === 100) break;
    }
  } catch (error) {
    console.error('github: review history unavailable', error);
  }

  return {
    repo: pr.repo,
    number: pr.number,
    author,
    baseSha: view.base.sha,
    headSha: view.head.sha,
    ...(since ? { since } : {}),
    ...(prior.length ? { prior } : {}),
  };
}

async function threads(
  pr: { repo: string; number: number; author: string },
  token: string,
  request: Fetcher = fetch,
): Promise<Map<string, string>> {
  const comments = await all<Posted>(
    token,
    `/repos/${pr.repo}/pulls/${pr.number}/comments`,
    request,
  );

  return marked(comments.filter(comment => comment.user?.login === pr.author));
}

async function post(
  pr: { repo: string; number: number; headSha: string },
  review: { comments: ReviewComment[]; body(threads: Map<string, string>): string },
  token: string,
  request: Fetcher = fetch,
): Promise<{ url: string }> {
  const path = `/repos/${pr.repo}/pulls/${pr.number}/reviews`;
  const { data: created } = await call<{ id: number; html_url: string }>(token, path, request, {
    method: 'POST',
    body: {
      commit_id: pr.headSha,
      event: 'COMMENT',
      body: review.body(new Map()),
      comments: review.comments.map(comment => ({
        path: comment.file,
        line: comment.line,
        side: 'RIGHT',
        ...(comment.startLine ? { start_line: comment.startLine, start_side: 'RIGHT' } : {}),
        body: comment.body,
      })),
    },
  });
  // The new threads exist only once the review does; its body then links them too, or keeps its titles unlinked.
  if (review.comments.length)
    try {
      const fresh = marked(await all<Posted>(token, `${path}/${created.id}/comments`, request));
      await call(token, `${path}/${created.id}`, request, {
        method: 'PUT',
        body: { body: review.body(fresh) },
      });
    } catch (error) {
      console.error(`github: review ${created.html_url} keeps its first body`, error);
    }

  return { url: created.html_url };
}

function localToken(cwd: string): string {
  try {
    return execFileSync('gh', ['auth', 'token'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'Pull request reviews on this machine need the GitHub CLI signed in: gh auth login',
    );
  }
}

const startCheck: PullRequestReviews['startCheck'] = async (pr, check, token, request = fetch) => {
  try {
    const { data } = await call<{ id: number; html_url?: string }>(
      token,
      `/repos/${pr.repo}/check-runs`,
      request,
      {
        method: 'POST',
        body: {
          name: check.name,
          head_sha: pr.headSha,
          status: 'in_progress',
          ...(check.detailsUrl ? { details_url: check.detailsUrl } : {}),
        },
      },
    );

    return { id: data.id, ...(data.html_url ? { url: data.html_url } : {}) };
  } catch (error) {
    console.error('github: could not start review check', error);
    return undefined;
  }
};

const finishCheck: PullRequestReviews['finishCheck'] = async (
  pr,
  id,
  outcome,
  token,
  request = fetch,
) => {
  const finish = (summary: string) =>
    call(token, `/repos/${pr.repo}/check-runs/${id}`, request, {
      method: 'PATCH',
      body: {
        status: 'completed',
        conclusion: outcome.conclusion,
        output: { title: outcome.title, summary },
        ...(outcome.detailsUrl ? { details_url: outcome.detailsUrl } : {}),
      },
    });

  try {
    await finish(outcome.summary);
  } catch {
    try {
      await finish('See the posted review.');
    } catch (error) {
      console.error('github: could not finish review check', error);
    }
  }
};

export const githubReviews: PullRequestReviews = {
  startCheck,
  finishCheck,
  parse: parseGithubPr,
  repository,
  head,
  target,
  threads,
  post,
  localToken,
};
