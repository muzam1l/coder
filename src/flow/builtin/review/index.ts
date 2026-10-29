/**
 * Built-in `review` flow behind `coder review`, review agents and the task `review` tool. An ordinary
 * flow file: a repo `.coder/flows/review.ts` overrides it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as z from 'zod';
import { CoderError, task } from '@wular/coder/flow';

import { INTEGRATIONS } from '../../../integrations';
import type { PullRequestReviews, ReviewTarget } from '../../../integrations/types';
import { postedMarkdown } from '../../../core/task/posted';
import { DEFAULT_SERVER } from '../../../client/auth/session';
import { postReview, reviewCheckSummary, type ReviewLinks } from './post';
import { loadConfig } from '../../../core/config';
import { readFlowRecord } from '../../runs';
import {
  ctxALS,
  onRunStop,
  currentChecksToken,
  currentIntegrationToken,
  currentReviewLinks,
} from '../../runtime';
import { reviewPrompt, reviewSystemPrompt } from './prompts';

export const description = 'Review a code change.';

export const args = z.object({
  /** PR number in the checkout's origin, or a GitHub PR URL. */
  pr: z.union([z.number(), z.string()]).optional(),
  /** `owner/name` of the PR's repository; defaults to the checkout's origin. */
  repo: z.string().optional(),
  base: z.string().optional(),
  head: z.string().optional(),
  /** Only review lines newer than this commit; with `pr` defaults to the last reviewed head. */
  since: z.string().optional(),
  /** Post one review on the PR. */
  post: z.boolean().optional(),
  /** The task event's PR, the only one a read-only run may post on. */
  eventPr: z.number().optional(),
  /** GitHub login whose comments carry trusted review markers; defaults to the `gh` user. */
  author: z.string().optional(),
  /** Git pathspecs relative to `cwd`; submodule contents included. */
  path: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  /** A model spec, the workspace's review model by default. */
  model: z.string().optional(),
  /** What the review reports: confirmed critical and major defects, any a maintainer would act on, or nits too. */
  depth: z.enum(['low', 'medium', 'high']).optional(),
  cwd: z.string().optional(),
});
export type ReviewArgs = z.infer<typeof args>;

/** Tasks at once unless the caller sets a concurrency. */
export const concurrency = 4;

const Severity = z.enum(['critical', 'major', 'minor', 'nit']);
const Category = z.enum([
  'correctness',
  'security',
  'reliability',
  'performance',
  'maintainability',
  'testing',
  'documentation',
]);
const Finding = z.strictObject({
  file: z.string().describe('A changed file.'),
  line: z.number().meta({ type: 'integer' }).describe('The changed new-side line it anchors on.'),
  start_line: z
    .number()
    .meta({ type: 'integer' })
    .nullable()
    .describe('First line when the defect spans consecutive changed lines in one hunk, else null.'),
  severity: Severity,
  category: Category,
  summary: z.string().describe('A title of at most 10 words.'),
  failure_scenario: z.string().describe('The concrete failure.'),
});
type Severity = z.infer<typeof Severity>;
export type Finding = Omit<z.infer<typeof Finding>, 'start_line'> & {
  start_line?: number;
  fingerprint: string;
  inline?: boolean;
};

/** The platform pull requests are reviewed on. */
export const REVIEW_PLATFORM = 'github';

export interface ReviewSummary {
  baseSha: string;
  headSha: string;
  /** Also covers uncommitted and untracked files on top of `headSha`. */
  worktree: boolean;
  files: number;
  model: string | null;
  elapsedMs: number;
  /** New inline comments, once a caller posted the review. */
  posted?: number;
  /** The posted review. */
  url?: string;
  checkUrl?: string;
  /** Parts left out of the review, such as uninitialized submodules. */
  warnings?: string[];
}

export interface ReviewResult {
  /** The reviewer's headline; may be empty. */
  title: string;
  findings: Finding[];
  /** The reviewer's own markdown beyond the findings; may be empty. */
  body: string;
  summary: ReviewSummary;
  /** The reviewed pull request, for a caller that posts the review. */
  pr?: ReviewTarget;
}

/** A review's findings as the CLI prints them and a task receives them. */
export function renderReviewMarkdown(result: ReviewResult & { runId: string }): string {
  const { summary } = result;
  const range = `\`${summary.baseSha}\`${summary.worktree ? ' through the working tree' : `..\`${summary.headSha}\``}`;
  const warnings = (summary.warnings ?? []).flatMap(w => [w, '']);
  if (summary.worktree && !summary.files)
    return `${[...(result.title?.trim() ? [result.title.trim(), ''] : []), '# Coder review', '', `Nothing to review from ${range}.`, '', ...warnings, `Flow run: \`${result.runId}\``].join('\n')}\n`;
  const lines = [
    ...(result.title?.trim() ? [result.title.trim(), ''] : []),
    '# Coder review',
    '',
    `Reviewed ${result.pr ? `pull request #${result.pr.number}, ` : ''}${range}${summary.model ? ` with ${summary.model}` : ''} in ${(summary.elapsedMs / 1000).toFixed(1)}s.`,
    '',
    ...warnings,
    ...(result.body?.trim() ? [result.body.trim(), ''] : []),
    ...(result.findings.length
      ? result.findings.flatMap(f => [
          `- **${f.severity.toUpperCase()}** [\`${f.file}:${f.start_line ? `${f.start_line}-` : ''}${f.line}\`]. ${f.summary}`,
          `  ${f.failure_scenario}`,
        ])
      : ['No findings after checking against the repository.']),
  ];
  if (summary.url)
    lines.push(
      '',
      `Posted [the review](${summary.url}) with ${summary.posted ?? 0} new inline comment${summary.posted === 1 ? '' : 's'}.`,
    );
  lines.push('', `Flow run: \`${result.runId}\``);
  return `${lines.join('\n')}\n`;
}

const RANK: Record<Severity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  nit: 3,
};

/** New-side line ranges per file from a unified diff. */
export function changedLines(patch: string): Map<string, Array<[number, number]>> {
  const ranges = new Map<string, Array<[number, number]>>();
  let file = '';
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '').split('\t')[0]!;
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk || file === '/dev/null') continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) ranges.set(file, [...(ranges.get(file) ?? []), [start, start + count - 1]]);
  }
  return ranges;
}

/** Stable finding key from its file, category and neighbouring lines. */
export function fingerprint(file: string, text: string, category: string): string {
  return createHash('sha1').update(`${file}\n${category}\n${text.trim()}`).digest('hex');
}

/** Rules come from the base commit, so a PR cannot rewrite the rules that review it. */
function readRules(exec: ReviewExec, sha: string, file: string): string | undefined {
  try {
    const text = exec('git', ['show', `${sha}:${file}`]);
    return text.length > 32_000 ? `${text.slice(0, 32_000)}\n[truncated]` : text;
  } catch {
    return undefined;
  }
}

/** AGENTS.md / CLAUDE.md, then .coder/review.md, all read at `sha`. */
export function repositoryRules(
  exec: ReviewExec,
  sha: string,
): Array<[name: string, text: string]> {
  return ['AGENTS.md', 'CLAUDE.md', '.coder/review.md'].flatMap(name => {
    const text = readRules(exec, sha, name);
    return text?.trim() ? [[name, text] as [string, string]] : [];
  });
}

function defaultBase(exec: ReviewExec): string {
  for (const cmd of [
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    ['rev-parse', '--verify', 'origin/main'],
    ['rev-parse', '--verify', 'origin/master'],
  ]) {
    try {
      const resolved = exec('git', cmd).trim();
      return exec('git', [
        'merge-base',
        'HEAD',
        cmd[0] === 'symbolic-ref' ? resolved : cmd[2]!,
      ]).trim();
    } catch {
      /* next */
    }
  }
  throw new CoderError('invalid-option', 'Could not detect origin default branch; pass base.');
}

export interface ReviewServices {
  exec?: ReviewExec;
  reviewTask?: typeof task;
  /** Test-only override for the transient task credential. */
  integrationToken?: string;
  request?: typeof fetch;
}

const reviews = (): PullRequestReviews => INTEGRATIONS[REVIEW_PLATFORM]!.repos!.reviews!;

/** The pull request's head moved after the review read it. */
class HeadMovedError extends Error {
  constructor(readonly head: string) {
    super(`The pull request moved to ${head.slice(0, 7)} since this review. Review again.`);
  }
}

/** Posts a pull request review with the driver's token and links, else the local user's, once its head has not moved. */
export async function postReviewHere(
  result: ReviewResult,
  cwd: string,
  request: typeof fetch = fetch,
  token = currentIntegrationToken(),
): Promise<ReviewResult> {
  if (!result.pr)
    throw new CoderError('invalid-option', 'Only a pull request review can be posted.');
  const platform = reviews();
  token ??= platform.localToken(cwd);
  const head = await platform.head(result.pr, token, request);
  if (head !== result.pr.headSha) throw new HeadMovedError(head);
  const stopped = () => ctxALS.getStore()?.stopping === true;
  if (stopped()) throw new Error('The review was stopped before posting.');
  const posted = await postReview(
    platform,
    {
      target: result.pr,
      findings: result.findings,
      title: result.title ?? '',
      body: result.body,
      links: currentReviewLinks() ?? localReviewLinks(),
    },
    token,
    request,
    stopped,
  );

  return {
    ...result,
    title: result.title ?? '',
    summary: { ...result.summary, posted: posted.posted, url: posted.url },
  };
}

function localReviewLinks(): ReviewLinks {
  return {
    from: 'cli',
    coder: `${DEFAULT_SERVER}/docs/review`,
  };
}

/** Posts a finished review run from this machine, as the person signed in to the platform there. */
export async function postReviewRun(
  runId: string,
  cwd: string,
): Promise<ReviewResult & { runId: string }> {
  const record = readFlowRecord(runId);
  if (record?.status !== 'completed')
    throw new CoderError('invalid-option', `Review run "${runId}" has not finished.`);

  return { ...(await postReviewHere(record.result as ReviewResult, cwd)), runId };
}

/** Git config in the environment that sends `token` to the origin of `url`, the platform's clone host by default, kept out of the command line, with no system or global config read. */
export function fetchEnvironment(token: string, url?: string): Record<string, string> {
  const repos = INTEGRATIONS[REVIEW_PLATFORM]!.repos!;
  const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  const basic = Buffer.from(`${repos.credentialUsername}:${token}`).toString('base64');
  const origin = url ? new URL(url).origin : `https://${repos.cloneHosts[0]}`;

  return {
    // No repository-configured transport, such as `ext::`, ever sees the header.
    GIT_ALLOW_PROTOCOL: 'https',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: `http.${origin}/.extraheader`,
    [`GIT_CONFIG_VALUE_${count}`]: `AUTHORIZATION: basic ${basic}`,
  };
}

/** A detached worktree of the checkout at `sha`, removed on `close`. */
function headWorktree(exec: ReviewExec, sha: string): { dir: string; close(): void } {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'coder-review-head-')));
  exec('git', ['worktree', 'add', '--detach', '--quiet', dir, sha]);

  return {
    dir,
    close() {
      try {
        exec('git', ['worktree', 'remove', '--force', dir]);
      } catch {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** Checks out each submodule at `prefixes` in the worktree at `dir`, one commit deep, parents first, with the task's git credentials as checkout uses them; a failure is a warning. */
async function headSubmodules(
  dir: string,
  prefixes: string[],
  token: string | undefined,
  warnings: string[],
): Promise<void> {
  const { withGitToken } = await import('../../../runner/task');
  const host = INTEGRATIONS[REVIEW_PLATFORM]!.repos!.cloneHosts[0]!;
  await withGitToken(path.dirname(dir), token, host, async options => {
    for (const prefix of [...prefixes].sort((a, b) => a.length - b.length)) {
      const parent =
        prefixes
          .filter(p => p !== prefix && prefix.startsWith(p))
          .sort()
          .at(-1) ?? '';
      try {
        reviewCli(path.join(dir, parent), options?.env)('git', [
          'submodule',
          'update',
          '--init',
          '--depth',
          '1',
          '--',
          prefix.slice(parent.length, -1),
        ]);
      } catch (error) {
        const reason = String((error as { stderr?: string }).stderr || error)
          .trim()
          .split('\n')[0];
        warnings.push(
          `Submodule ${prefix.slice(0, -1)} was not checked out at the head (${reason}).`,
        );
      }
    }
  });
}

/** A credentialed fetch that reads none of the checkout's config: it runs in a temporary bare repository holding the checkout's refs and writes into the checkout's object store, so the checkout reads the fetched commits. */
export function fetchInto(
  cwd: string,
  exec: ReviewExec,
  token: string,
  url?: string,
): { fetch: ReviewExec; env: Record<string, string>; close(): void } {
  const gitPath = (name: string) =>
    path.resolve(cwd, exec('git', ['rev-parse', '--git-path', name]).trim());
  const objects = gitPath('objects');
  const shallow = gitPath('shallow');
  const refs = exec('git', ['for-each-ref', '--format=%(objectname) %(refname)']);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'coder-review-'));
  // A shallow checkout keeps the boundary the fetch moved.
  const close = () => {
    if (existsSync(path.join(dir, 'shallow'))) copyFileSync(path.join(dir, 'shallow'), shallow);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const env = { ...fetchEnvironment(token, url), GIT_DIR: dir, GIT_OBJECT_DIRECTORY: objects };
    const fetch = reviewCli(cwd, env);
    fetch('git', ['init', '-q', '--bare']);
    // The checkout's refs and shallow boundary tell the remote what is already here.
    writeFileSync(path.join(dir, 'packed-refs'), `# pack-refs with: peeled fully-peeled\n${refs}`);
    if (existsSync(shallow)) copyFileSync(shallow, path.join(dir, 'shallow'));

    return { fetch, env, close };
  } catch (error) {
    close();
    throw error;
  }
}

/** A pull request's range and fetched commits, read with the driver's token or local user token. */
async function pullRequestTarget(
  a: ReviewArgs,
  cwd: string,
  exec: ReviewExec,
  services: ReviewServices,
  onTarget?: (target: ReviewTarget) => Promise<void>,
): Promise<ReviewTarget> {
  const platform = reviews();
  const ref = platform.parse(a.pr!);
  if (!ref)
    throw new CoderError(
      'invalid-option',
      `pr must be a PR number or GitHub PR URL, got "${a.pr}".`,
      {
        hint: 'Use base/head for a local review on any host.',
      },
    );
  if (ref.repo && a.repo && ref.repo.toLowerCase() !== a.repo.toLowerCase())
    throw new CoderError('invalid-option', `pull request is in ${ref.repo}, not in ${a.repo}`);
  const repo = ref.repo ?? a.repo ?? platform.repository(cwd);
  if (!repo)
    throw new CoderError(
      'invalid-option',
      'This checkout has no GitHub origin; pass the pull request URL.',
    );
  const appToken = services.integrationToken ?? currentIntegrationToken();
  if (appToken && !a.author) throw new Error('GitHub review task is missing its author');
  const token = appToken ?? platform.localToken(cwd);
  const target = await platform.target(
    { repo, number: ref.number, ...(a.author ? { author: a.author } : {}) },
    token,
    services.request,
  );
  await onTarget?.(target);
  const { since: previous, ...range } = target;
  // A force-push can leave the last reviewed head unfetchable; the whole pull request is reviewed then.
  let last = previous;
  if (![range.baseSha, range.headSha, ...(last ? [last] : [])].every(sha => hasCommit(exec, sha))) {
    const url = `${INTEGRATIONS[REVIEW_PLATFORM]!.repos!.url(repo)}.git`;
    const fetching = services.exec
      ? { fetch: services.exec, close() {} }
      : fetchInto(cwd, exec, token, url);
    const refs = ['fetch', '-q', url, range.baseSha, range.headSha];
    try {
      fetching.fetch('git', [...refs, ...(last ? [last] : [])]);
    } catch (error) {
      if (!last) throw error;
      fetching.fetch('git', refs);
      last = undefined;
    } finally {
      fetching.close();
    }
  }
  const since = a.since ? commitOf(exec, a.since) : last;
  let forcePushed = false;
  if (since && hasCommit(exec, since))
    try {
      exec('git', ['merge-base', '--is-ancestor', since, range.headSha]);
    } catch {
      forcePushed = true;
    }

  // The pull request's own changes start where it left its base, as its diff on the platform does.
  return {
    ...range,
    ...(forcePushed ? { forcePushed: true } : {}),
    baseSha: mergeBase(exec, range.baseSha, range.headSha) ?? range.baseSha,
    ...(since && hasCommit(exec, since) ? { since } : {}),
  };
}

/** Resolve local refs directly and pull requests through their platform. */
async function resolveTarget(
  exec: ReviewExec,
  a: ReviewArgs,
  cwd: string,
  services: ReviewServices,
  onTarget?: (target: ReviewTarget) => Promise<void>,
): Promise<{ baseSha: string; headSha: string; since?: string; pr?: ReviewTarget }> {
  if (a.pr === undefined) {
    const headSha = exec('git', ['rev-parse', a.head ?? 'HEAD']).trim();
    const baseSha = a.base ? exec('git', ['rev-parse', a.base]).trim() : defaultBase(exec);
    return {
      baseSha,
      headSha,
      ...(a.since ? { since: a.since } : {}),
    };
  }
  const pr = await pullRequestTarget(a, cwd, exec, services, onTarget);

  return {
    baseSha: pr.baseSha,
    headSha: pr.headSha,
    ...(pr.since ? { since: pr.since } : {}),
    pr,
  };
}

type Ranges = Map<string, Array<[number, number]>>;

/** The checkout, or a submodule at `prefix` with its pointers; no `head` means the working tree. */
interface Repo {
  prefix: string;
  base: string;
  head?: string;
  since?: string;
  include: string[];
  exclude: string[];
}

type Git = (r: Repo, args: string[], input?: string) => string;

const pathspec = (r: Repo) => [
  '--',
  ...r.include.map(p => `:(top)${p}`),
  ...r.exclude.map(p => `:(top,exclude)${p}`),
];

/** Top-relative `p` inside the repository at `prefix`: "" when it covers all of it, undefined when outside. */
function within(p: string, prefix: string): string | undefined {
  if (!prefix || p.startsWith(prefix)) return p.slice(prefix.length);
  return !p || prefix.startsWith(`${p}/`) ? '' : undefined;
}

/** Untracked, not ignored files, each changed in full; nested repositories are warned about. */
function untrackedLines(git: Git, root: string, r: Repo, warnings: string[]): Ranges {
  const ranges: Ranges = new Map();
  for (const file of git(r, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--full-name',
    '-z',
    ...pathspec(r),
  ]).split('\0')) {
    if (file.endsWith('/')) {
      warnings.push(
        `Skipped ${r.prefix}${file.slice(0, -1)} because it is a nested repository, not a submodule.`,
      );
      continue;
    }
    let text = '';
    try {
      if (file) text = readFileSync(path.join(root, r.prefix, file), 'utf8');
    } catch {
      /* not a readable file */
    }
    const lines = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
    if (lines) ranges.set(file, [[1, lines]]);
  }
  return ranges;
}

/** Changed lines of tracked files from `from` to `r.head`, or to the working tree. */
const diffRanges = (git: Git, r: Repo, from: string): Ranges =>
  changedLines(
    git(r, [
      'diff',
      '--no-ext-diff',
      '--find-renames',
      '--ignore-submodules=all',
      '-U0',
      r.head ? `${from}..${r.head}` : from,
      ...pathspec(r),
    ]),
  );

/** Changed or dirty submodules of `r` in scope, each as a repository of its own. */
function submodules(
  git: Git,
  root: string,
  r: Repo,
  scope: (prefix: string) => Pick<Repo, 'include' | 'exclude'> | undefined,
  warnings: string[],
): Repo[] {
  const raw = git(r, [
    'diff',
    '--raw',
    '-z',
    '--no-abbrev',
    '--no-renames',
    '--ignore-submodules=none',
    r.head ? `${r.base}..${r.head}` : r.base,
  ]).split('\0');
  const repos: Repo[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const [oldMode, newMode, oldSha, newSha] = raw[i]!.slice(1).split(' ');
    const sub = `${r.prefix}${raw[i + 1]}`;
    const inScope = scope(`${sub}/`);
    // Removed submodules leave nothing to review.
    if (newMode !== '160000' || !inScope) continue;
    if (!existsSync(path.join(root, sub, '.git'))) {
      warnings.push(`Skipped submodule ${sub} because it is not initialized.`);
      continue;
    }
    const child = { prefix: `${sub}/`, base: '', ...inScope };
    const empty = () => git(child, ['hash-object', '-t', 'tree', '--stdin'], '').trim();
    const pointer = (sha: string) =>
      git(r, ['ls-tree', '--full-tree', sha, raw[i + 1]!]).match(/^160000 commit (\S+)/)?.[1];
    const repo: Repo = {
      ...child,
      base: oldMode === '160000' ? oldSha! : empty(),
      ...(r.head ? { head: newSha } : {}),
      ...(r.since ? { since: pointer(r.since) ?? empty() } : {}),
    };
    const missing = [repo.base, repo.head, repo.since].find(sha => {
      if (!sha) return false;
      try {
        git(repo, ['cat-file', '-e', `${sha}^{tree}`]);
        return false;
      } catch {
        return true;
      }
    });
    if (missing)
      warnings.push(`Skipped submodule ${sub} because commit ${missing} is not fetched.`);
    else repos.push(repo, ...submodules(git, root, repo, scope, warnings));
  }
  return repos;
}

export default async function review(
  a: ReviewArgs,
  services: ReviewServices = {},
): Promise<ReviewResult> {
  if (a.pr !== undefined && (a.base || a.head))
    throw new CoderError('invalid-option', 'pr cannot be combined with base or head.');
  if (a.post && a.pr === undefined) throw new CoderError('invalid-option', 'post requires pr.');
  if (a.post && ctxALS.getStore()?.access === 'read-only') {
    const number = reviews().parse(a.pr!)?.number;
    if (a.eventPr === undefined || number !== a.eventPr)
      throw new Error('A read-only task cannot post reviews.');
  }

  const started = Date.now();
  const cwd = path.resolve(a.cwd ?? process.cwd());
  const exec = services.exec ?? reviewCli(cwd);
  const token = currentChecksToken();
  let starting: Promise<void> | undefined;
  let unregister = () => {};
  let check: { id: number; url?: string } | undefined;
  let target: ReviewTarget | undefined;
  try {
    const resolved = await resolveTarget(exec, a, cwd, services, async pr => {
      target = pr;
      if (a.post && token && !ctxALS.getStore()?.stopping) {
        unregister = onRunStop(async () => {
          await starting;
          if (check)
            await reviews().finishCheck(
              pr,
              check.id,
              {
                conclusion: 'cancelled',
                title: 'Review stopped',
                summary: 'The review did not finish.',
              },
              token,
              services.request,
            );
        });
        starting = reviews()
          .startCheck(
            pr,
            { name: 'Coder review', detailsUrl: currentReviewLinks()?.task },
            token,
            services.request,
          )
          .then(started => {
            check = started;
          });
        await starting;
      }
    });
    const result = await reviewChange(a, services, resolved, cwd, exec, started);
    if (check && target && token && !ctxALS.getStore()?.stopping) {
      if (check.url) result.summary.checkUrl = check.url;
      const count = result.findings.length;
      const worst = result.findings[0]?.severity;
      const unresolved = target.prior?.filter(p => p.state !== 'resolved').length ?? 0;
      await reviews().finishCheck(
        target,
        check.id,
        {
          conclusion: count || unresolved ? 'neutral' : 'success',
          title: `Reviewed ${target.headSha.slice(0, 7)}: ${
            count
              ? `${count} issue${count === 1 ? '' : 's'}, worst ${worst}`
              : unresolved
                ? `no new issues, ${unresolved} unresolved`
                : 'no issues'
          }`,
          summary: reviewCheckSummary(
            await postedMarkdown(result.title),
            await Promise.all(
              result.findings.map(async finding => ({
                ...finding,
                summary: await postedMarkdown(finding.summary),
              })),
            ),
            result.summary.url!,
            currentReviewLinks()?.task,
          ),
          detailsUrl: currentReviewLinks()?.task ?? result.summary.url,
        },
        token,
        services.request,
      );
      unregister();
    }

    return result;
  } catch (error) {
    if (check && target && token && !ctxALS.getStore()?.stopping) {
      await reviews().finishCheck(
        target,
        check.id,
        error instanceof HeadMovedError
          ? {
              conclusion: 'skipped',
              title: `Head moved to ${error.head.slice(0, 7)}`,
              summary: 'Reviewing the new head.',
            }
          : {
              conclusion: 'neutral',
              title: 'Review failed',
              summary: 'The review did not finish.',
            },
        token,
        services.request,
      );
      unregister();
    }
    throw error;
  }
}

/** Reviews the resolved range and posts it when asked. */
async function reviewChange(
  a: ReviewArgs,
  services: ReviewServices,
  { pr, baseSha, headSha, since }: Awaited<ReturnType<typeof resolveTarget>>,
  cwd: string,
  exec: ReviewExec,
  started: number,
): Promise<ReviewResult> {
  // Without `head`, a local review covers uncommitted and untracked files too.
  const worktree = a.pr === undefined && !a.head;
  const root = realpathSync(exec('git', ['rev-parse', '--show-toplevel']).trim());
  const git: Git = (r, args, input) =>
    exec('git', r.prefix ? ['-C', path.join(root, r.prefix), ...args] : args, input);
  const here = realpathSync(cwd);
  const top = (p: string) => path.relative(root, path.resolve(here, p)).split(path.sep).join('/');
  const paths = (a.path ?? []).map(top);
  const excluded = (a.exclude ?? []).map(top);
  const scope = (prefix: string) => {
    const include = (paths.length ? paths : [''])
      .map(p => within(p, prefix))
      .filter(p => p !== undefined);
    const exclude = excluded.map(p => within(p, prefix));
    if (!include.length || exclude.includes('')) return undefined;
    return { include, exclude: exclude.filter(p => p !== undefined) };
  };
  const checkout = scope('');
  if (!checkout) throw new CoderError('invalid-option', 'exclude leaves nothing to review.');
  const warnings: string[] = [];
  if (pr?.forcePushed && since)
    warnings.push(
      `The branch no longer contains ${since.slice(0, 7)} after a force-push; reviewed lines changed since it.`,
    );
  const parent: Repo = {
    prefix: '',
    base: baseSha,
    ...(worktree ? {} : { head: headSha }),
    ...(since ? { since } : {}),
    ...checkout,
  };
  const repos = [parent, ...submodules(git, root, parent, scope, warnings)];

  // Incremental rerun: only lines newer than `since`, and still part of the full diff.
  // An untracked file counts as newer when `since` lacks it or holds other content.
  const full: Ranges = new Map();
  const newer: Ranges = new Map();
  const untracked = new Set<string>();
  for (const r of repos) {
    const loose = worktree ? untrackedLines(git, root, r, warnings) : (new Map() as Ranges);
    const changedSince = (file: string) => {
      try {
        return (
          git(r, ['show', `${r.since}:${file}`]) !==
          readFileSync(path.join(root, r.prefix, file), 'utf8')
        );
      } catch {
        return true;
      }
    };
    for (const [file, rs] of [...diffRanges(git, r, r.base), ...loose])
      full.set(r.prefix + file, rs);
    if (r.since)
      for (const [file, rs] of [
        ...diffRanges(git, r, r.since),
        ...[...loose].filter(([file]) => changedSince(file)),
      ])
        newer.set(r.prefix + file, rs);
    for (const file of loose.keys()) untracked.add(r.prefix + file);
  }
  let ranges = full;
  if (since) {
    const overlaps = (r: [number, number], rs: Array<[number, number]>) =>
      rs.some(([s, e]) => r[0] <= e && r[1] >= s);
    ranges = new Map(
      [...newer]
        .map(([file, rs]) => [file, rs.filter(r => overlaps(r, full.get(file) ?? []))] as const)
        .filter(([, rs]) => rs.length),
    );
  }

  if (worktree && !ranges.size)
    return {
      findings: [],
      title: '',
      body: '',
      summary: {
        baseSha,
        headSha,
        worktree,
        files: 0,
        model: null,
        elapsedMs: Date.now() - started,
        ...(warnings.length ? { warnings } : {}),
      },
    };

  const common = {
    model: a.model ?? loadConfig(cwd).reviewModel,
    access: 'read-only' as const,
    cwd,
    appendSystem: reviewSystemPrompt(a.depth ?? 'medium', repositoryRules(exec, baseSha)),
  };

  const files = [...ranges]
    .map(
      ([file, r]) =>
        `- ${file} (${untracked.has(file) ? 'untracked, ' : ''}lines ${r.map(([s, e]) => (s === e ? s : `${s}-${e}`)).join(', ')})`,
    )
    .join('\n');
  // Findings off a changed line fail validation; the runtime re-asks the model with the message.
  const onChangedLine = (f: z.infer<typeof Finding>) =>
    (ranges.get(f.file) ?? []).some(([s, e]) => f.line >= s && f.line <= e);
  const Findings = z.strictObject({
    findings: z.array(
      Finding.superRefine((f, ctx) => {
        if (!Number.isSafeInteger(f.line) || f.line <= 0 || !onChangedLine(f))
          ctx.addIssue({
            code: 'custom',
            path: ['line'],
            message: `${f.file}:${f.line} is not a changed line; use a line from the changed files list`,
          });
        if (
          f.start_line !== null &&
          (!Number.isSafeInteger(f.start_line) ||
            f.start_line <= 0 ||
            f.start_line > f.line ||
            !(full.get(f.file) ?? []).some(([s, e]) => f.start_line! >= s && f.line <= e))
        )
          ctx.addIssue({
            code: 'custom',
            path: ['start_line'],
            message: `${f.file}:${f.start_line}-${f.line} does not lie in one changed hunk; use line alone or shrink the range to one hunk`,
          });
      }),
    ),
    title: z
      .string()
      .refine(
        title => /^[^\n]{1,80}$/.test(title.trim()),
        'Write the title as one line of 1 to 80 characters',
      )
      .describe(
        'The verdict in one line of at most 80 characters, such as "No defects found" or "2 bugs: …".',
      ),
    body: z
      .string()
      .describe(
        'Markdown for what is not tied to one changed line, such as a pattern across files or a step before merging. Empty when nothing matters beyond the findings.',
      ),
  });
  const from = since ?? baseSha;
  const command = (r: Repo) => {
    const dir = r.prefix ? ` -C ${path.relative(here, path.join(root, r.prefix))}` : '';
    const spec =
      paths.length || excluded.length
        ? ` ${pathspec(r)
            .map(s => (s === '--' ? s : `'${s}'`))
            .join(' ')}`
        : '';
    const start = r.since ?? r.base;
    return `git${dir} diff ${r.head ? `${start}..${r.head}` : start}${spec}`;
  };
  const nested = repos
    .slice(1)
    .filter(r => [...ranges.keys()].some(file => file.startsWith(r.prefix)))
    .map(r => ({ prefix: r.prefix, command: command(r) }));
  // The reviewer reads the files at the reviewed head: a checkout elsewhere, such as a task's default branch, lends a detached worktree.
  const atHead =
    !worktree && exec('git', ['rev-parse', 'HEAD']).trim() !== headSha
      ? headWorktree(exec, headSha)
      : undefined;
  if (atHead && nested.length)
    await headSubmodules(
      atHead.dir,
      nested.map(r => r.prefix),
      services.integrationToken ?? currentIntegrationToken(),
      warnings,
    );
  const reviewed = await (services.reviewTask ?? task)(
    reviewPrompt({
      from,
      ...(worktree ? {} : { head: headSha }),
      command: command(parent),
      submodules: nested,
      files,
      prior: pr?.prior,
    }),
    {
      ...common,
      ...(atHead ? { cwd: path.join(atHead.dir, path.relative(root, here)) } : {}),
      name: 'Review',
      returns: Findings,
    },
  ).finally(() => atHead?.close());

  const lines = new Map<string, string[]>();
  const byPrefix = [...repos].sort((x, y) => y.prefix.length - x.prefix.length);
  // The flagged line with its nearest non-blank neighbours, so equal lines in one file stay apart.
  const lineText = (file: string, line: number) => {
    if (!lines.has(file)) {
      const repo = byPrefix.find(candidate => file.startsWith(candidate.prefix))!;
      const rel = file.slice(repo.prefix.length);
      let text = '';
      // A finding on a file the head no longer has keeps a fingerprint by file and category.
      try {
        text = repo.head
          ? git(repo, ['show', `${repo.head}:${rel}`])
          : readFileSync(path.join(root, repo.prefix, rel), 'utf8');
      } catch (error) {
        console.error(`coder review: ${file} could not be read for its fingerprint`, error);
      }
      lines.set(
        file,
        text.split('\n').map(entry => entry.trim()),
      );
    }
    const all = lines.get(file)!;
    const above =
      all
        .slice(0, line - 1)
        .reverse()
        .find(Boolean) ?? '';
    const below = all.slice(line).find(Boolean) ?? '';

    return [above, all[line - 1] ?? '', below].join('\n');
  };
  const findings: Finding[] = reviewed.data.findings
    .map(({ start_line, ...f }) => ({
      ...f,
      ...(start_line != null && start_line !== f.line ? { start_line } : {}),
      fingerprint: fingerprint(f.file, lineText(f.file, f.line), f.category),
      ...(pr && repos.some(r => r.prefix && f.file.startsWith(r.prefix)) ? { inline: false } : {}),
    }))
    .sort((x, y) => RANK[x.severity] - RANK[y.severity]);

  const summary: ReviewSummary = {
    baseSha,
    headSha,
    worktree,
    files: ranges.size,
    model: reviewed.model,
    elapsedMs: Date.now() - started,
  };
  if (warnings.length) summary.warnings = warnings;

  const result: ReviewResult = {
    findings,
    title: reviewed.data.title.trim(),
    body: reviewed.data.body.trim(),
    summary,
    ...(pr ? { pr } : {}),
  };

  return a.post && pr
    ? postReviewHere(result, cwd, services.request, services.integrationToken)
    : result;
}

export type ReviewExec = (command: string, args: string[], input?: string) => string;

export function reviewCli(cwd = process.cwd(), env: NodeJS.ProcessEnv = {}): ReviewExec {
  return (command, args, input) =>
    execFileSync(command, args, {
      cwd,
      env: { ...process.env, ...env },
      input,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
}

function mergeBase(exec: ReviewExec, base: string, head: string): string | undefined {
  try {
    return exec('git', ['merge-base', base, head]).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The full commit a ref names, or undefined when there is none here. */
function commitOf(exec: ReviewExec, ref: string): string | undefined {
  try {
    return exec('git', ['rev-parse', '--verify', `${ref}^{commit}`]).trim() || undefined;
  } catch {
    return undefined;
  }
}

function hasCommit(exec: ReviewExec, sha: string): boolean {
  try {
    exec('git', ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}
