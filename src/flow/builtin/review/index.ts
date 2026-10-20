/**
 * Built-in `review` flow behind `coder review`, review agents and the task `review` tool. An ordinary
 * flow file: a repo `.coder/flows/review.ts` overrides it.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import * as z from 'zod';
import { CoderError, task } from '@wular/coder/flow';

import { currentIntegrationToken } from '../../runtime';
import { reviewPrompt, reviewSystemPrompt } from './prompts';

export const description = 'Review a code change.';

export const args = z.object({
  /** PR number in the checkout's origin, or a GitHub PR URL. */
  pr: z.union([z.number(), z.string()]).optional(),
  base: z.string().optional(),
  head: z.string().optional(),
  /** Only review lines newer than this commit; with `pr` defaults to the last reviewed head. */
  since: z.string().optional(),
  /** Post inline comments and a sticky summary on the PR. */
  post: z.boolean().optional(),
  /** GitHub login whose comments carry trusted review markers; defaults to the `gh` user. */
  author: z.string().optional(),
  /** Git pathspecs relative to `cwd`; submodule contents included. */
  path: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  engine: z.string().optional(),
  model: z.string().optional(),
  /** Reasoning effort, and review depth in the prompt. */
  effort: z.enum(['low', 'medium', 'high']).optional(),
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
  file: z.string(),
  line: z.number().int().positive(),
  severity: Severity,
  category: Category,
  summary: z.string(),
  failure_scenario: z.string(),
});
type Severity = z.infer<typeof Severity>;
export type Finding = z.infer<typeof Finding> & { fingerprint: string };

export interface ReviewSummary {
  baseSha: string;
  headSha: string;
  /** Also covers uncommitted and untracked files on top of `headSha`. */
  worktree: boolean;
  files: number;
  model: string | null;
  elapsedMs: number;
  posted?: number;
  /** Parts left out of the review, such as uninitialized submodules. */
  warnings?: string[];
}

export interface ReviewResult {
  findings: Finding[];
  summary: ReviewSummary;
}

/** A review's findings as the CLI prints them and a task receives them. */
export function renderReviewMarkdown(result: ReviewResult & { runId: string }): string {
  const { summary } = result;
  const range = `\`${summary.baseSha}\`${summary.worktree ? ' through the working tree' : `..\`${summary.headSha}\``}`;
  const warnings = (summary.warnings ?? []).flatMap(w => [w, '']);
  if (summary.worktree && !summary.files)
    return `${['# Coder review', '', `Nothing to review from ${range}.`, '', ...warnings, `Flow run: \`${result.runId}\``].join('\n')}\n`;
  const lines = [
    '# Coder review',
    '',
    `Reviewed ${range}${summary.model ? ` with ${summary.model}` : ''} in ${(summary.elapsedMs / 1000).toFixed(1)}s.`,
    '',
    ...warnings,
    ...(result.findings.length
      ? result.findings.flatMap(f => [
          `- **${f.severity.toUpperCase()}** [\`${f.file}:${f.line}\`]. ${f.summary}`,
          `  ${f.failure_scenario}`,
        ])
      : ['No findings after checking against the repository.']),
  ];
  if (summary.posted !== undefined)
    lines.push(
      '',
      `Posted ${summary.posted} new inline comment${summary.posted === 1 ? '' : 's'}.`,
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
}

/** Resolve local refs directly and delegate pull requests to their integration. */
async function resolveTarget(
  exec: ReviewExec,
  a: ReviewArgs,
  cwd: string,
  auth: ReviewAuth,
): Promise<ReviewTarget> {
  if (a.pr === undefined) {
    const headSha = exec('git', ['rev-parse', a.head ?? 'HEAD']).trim();
    const baseSha = a.base ? exec('git', ['rev-parse', a.base]).trim() : defaultBase(exec);
    return {
      baseSha,
      headSha,
      ...(a.since ? { since: a.since } : {}),
    };
  }
  const input = {
    pr: a.pr,
    cwd,
    ...(a.since ? { since: a.since } : {}),
    ...(a.author ? { author: a.author } : {}),
  };
  return resolveReviewTarget(input, auth);
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

  const started = Date.now();
  const cwd = path.resolve(a.cwd ?? process.cwd());
  const exec = services.exec ?? reviewCli(cwd);
  const integrationToken = services.integrationToken ?? currentIntegrationToken();
  const integrationAuth: ReviewAuth = {
    ...(integrationToken ? { token: integrationToken } : {}),
    ...(services.exec ? { exec: services.exec } : {}),
  };
  const { pr, baseSha, headSha, since } = await resolveTarget(exec, a, cwd, integrationAuth);

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

  const effort = a.effort ?? 'medium';
  const common = {
    engine: a.engine,
    model: a.model,
    effort: a.effort,
    permissions: 'read-only',
    cwd,
    appendSystem: reviewSystemPrompt(effort, repositoryRules(exec, baseSha)),
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
        if (!onChangedLine(f))
          ctx.addIssue({
            code: 'custom',
            path: ['line'],
            message: `${f.file}:${f.line} is not a changed line; use a line from the changed files list`,
          });
      }),
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
  const reviewed = await (services.reviewTask ?? task)(
    reviewPrompt({
      from,
      ...(worktree ? {} : { head: headSha }),
      command: command(parent),
      submodules: nested,
      files,
    }),
    { ...common, name: 'Review', returns: Findings },
  );

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
    .map(f => ({
      ...f,
      fingerprint: fingerprint(f.file, lineText(f.file, f.line), f.category),
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
  const result: ReviewResult = {
    findings,
    summary,
  };
  if (a.post && pr) {
    // A pull request diff has no lines inside submodules to comment on.
    const inSubmodule = (f: Finding) => repos.some(r => r.prefix && f.file.startsWith(r.prefix));
    const skipped = findings.filter(inSubmodule).length;
    if (skipped)
      warnings.push(
        `Did not post ${skipped} submodule finding${skipped === 1 ? '' : 's'} because the pull request diff has no lines for them.`,
      );
    const postSummary: ReviewPostSummary = {
      ...summary,
      author: pr.author,
    };
    const input = {
      repo: pr.repo,
      pr: pr.number,
      cwd,
      findings: findings.filter(f => !inSubmodule(f)),
      summary: postSummary,
      ...(since ? { since } : {}),
    };
    summary.posted = postReview(input, integrationAuth);
  }
  if (warnings.length) summary.warnings = warnings;
  return result;
}

export type ReviewExec = (command: string, args: string[], input?: string) => string;

export type ReviewPostFinding = Finding;
export type ReviewPostSummary = Pick<
  ReviewSummary,
  'baseSha' | 'headSha' | 'model' | 'elapsedMs'
> & { author: string };

export interface ReviewPostInput {
  repo: string;
  pr: number;
  cwd?: string;
  findings: ReviewPostFinding[];
  summary: ReviewPostSummary;
  since?: string;
}

export interface ReviewTargetInput {
  pr: number | string;
  /** The only repository the target may be in. */
  repo?: string;
  cwd?: string;
  since?: string;
  author?: string;
}

export interface ReviewTarget {
  pr?: { number: number; repo: string; author: string };
  baseSha: string;
  headSha: string;
  since?: string;
}

export interface ReviewAuth {
  /** Installation token from the task context. Omit to use local gh auth. */
  token?: string;
  exec?: ReviewExec;
}

/** The platform reviews post to; its tool server holds the token. */
export const REVIEW_PLATFORM = 'github';

const REVIEW_FP_RE = /<!-- coder-review:fp=([a-f0-9]{40}) -->/g;

const REVIEW_SUMMARY_RE = /<!-- coder-review:summary head=([^\s>]+) -->/;

interface ReviewComment {
  id: number;
  body?: string | null;
  user?: { login?: string } | null;
}

export function reviewCli(cwd = process.cwd(), token?: string): ReviewExec {
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  return (command, args, input) =>
    execFileSync(command, args, {
      cwd,
      env,
      input,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
}

function reviewGh<T>(exec: ReviewExec, args: string[], input?: unknown): T {
  const output = exec('gh', args, input === undefined ? undefined : `${JSON.stringify(input)}\n`);
  return output.trim() ? (JSON.parse(output) as T) : (undefined as T);
}

const reviewPages = <T>(exec: ReviewExec, endpoint: string) =>
  reviewGh<T[][]>(exec, ['api', endpoint, '--paginate', '--slurp']).flat();

export function parseGithubPr(value: number | string): {
  number: number;
  repo?: string;
} {
  if (typeof value === 'number') return { number: value };
  if (/^\d+$/.test(value)) return { number: Number(value) };
  const match = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match)
    throw new CoderError(
      'invalid-option',
      `pr must be a PR number or GitHub PR URL, got "${value}".`,
      { hint: 'Use base/head for a local review on any host.' },
    );
  return { number: Number(match[3]), repo: `${match[1]}/${match[2]}` };
}

export function reviewFingerprints(comments: Array<{ body?: string | null }>): Set<string> {
  return new Set(
    comments.flatMap(comment =>
      [...(comment.body?.matchAll(REVIEW_FP_RE) ?? [])].map(match => match[1]!),
    ),
  );
}

export function lastReviewSummary(
  comments: Array<{ id: number; body?: string | null }>,
): { id: number; head: string } | undefined {
  for (const comment of [...comments].reverse()) {
    const match = comment.body?.match(REVIEW_SUMMARY_RE);
    if (match) return { id: comment.id, head: match[1]! };
  }
  return undefined;
}

export function ownReviewComments(comments: ReviewComment[], author: string): ReviewComment[] {
  return comments.filter(comment => comment.user?.login === author);
}

function ownReviewPages(exec: ReviewExec, endpoint: string, author: string): ReviewComment[] {
  return ownReviewComments(reviewPages<ReviewComment>(exec, endpoint), author);
}

function previousReview(
  exec: ReviewExec,
  repo: string,
  pr: number,
  author: string,
): { id: number; head: string } | undefined {
  return lastReviewSummary(ownReviewPages(exec, `repos/${repo}/issues/${pr}/comments`, author));
}

function hasCommit(exec: ReviewExec, sha: string): boolean {
  try {
    exec('git', ['cat-file', '-e', sha]);
    return true;
  } catch {
    return false;
  }
}

/** Resolve and fetch a GitHub pull request for the integration-generic review flow. */
export function resolveReviewTarget(input: ReviewTargetInput, auth: ReviewAuth = {}): ReviewTarget {
  if (!input.author && auth.token) throw new Error('GitHub review task is missing its author');
  const ref = parseGithubPr(input.pr);
  if (input.repo && ref.repo && ref.repo.toLowerCase() !== input.repo.toLowerCase())
    throw new CoderError(
      'invalid-option',
      `pull request is in ${ref.repo}, not in this task's repository ${input.repo}`,
    );

  const exec = auth.exec ?? reviewCli(input.cwd, auth.token);
  const bound = input.repo ?? ref.repo;
  const repoArgs = bound ? ['-R', bound] : [];
  const view = reviewGh<{
    baseRefOid: string;
    headRefOid: string;
    url: string;
  }>(exec, ['pr', 'view', String(ref.number), ...repoArgs, '--json', 'baseRefOid,headRefOid,url']);
  const repo = bound ?? new URL(view.url).pathname.split('/').slice(1, 3).join('/');
  exec('git', ['fetch', '-q', `https://github.com/${repo}.git`, view.baseRefOid, view.headRefOid]);

  const author = input.author ?? reviewGh<{ login: string }>(exec, ['api', 'user']).login;
  const since = input.since ?? previousReview(exec, repo, ref.number, author)?.head;

  return {
    pr: { number: ref.number, repo, author },
    baseSha: view.baseRefOid,
    headSha: view.headRefOid,
    ...(since && hasCommit(exec, since) ? { since } : {}),
  };
}

/** Post unseen findings and upsert the sticky summary through GitHub's integration. */
export function postReview(input: ReviewPostInput, auth: ReviewAuth = {}): number {
  const exec = auth.exec ?? reviewCli(input.cwd, auth.token);
  const { repo, pr, findings, summary, since } = input;
  const seen = reviewFingerprints(
    ownReviewPages(exec, `repos/${repo}/pulls/${pr}/comments`, summary.author),
  );
  const fresh = findings.filter(finding => !seen.has(finding.fingerprint));
  if (fresh.length)
    reviewGh(
      exec,
      ['api', `repos/${repo}/pulls/${pr}/reviews`, '--method', 'POST', '--input', '-'],
      {
        commit_id: summary.headSha,
        event: 'COMMENT',
        body: `Coder review: ${fresh.length} finding${fresh.length === 1 ? '' : 's'}.`,
        comments: fresh.map(finding => ({
          path: finding.file,
          line: finding.line,
          side: 'RIGHT',
          body: `**[${finding.severity.toUpperCase()}]** ${finding.summary}\n\n${finding.failure_scenario}\n\n<!-- coder-review:fp=${finding.fingerprint} -->`,
        })),
      },
    );

  const count = (severity: ReviewPostFinding['severity']) =>
    findings.filter(finding => finding.severity === severity).length;
  const range = since
    ? `Reviewed changes after \`${since}\` through \`${summary.headSha}\`.`
    : `Reviewed through \`${summary.headSha}\`.`;
  const body = `<!-- coder-review:summary head=${summary.headSha} -->
## Coder review

Findings in this run. Critical ${count('critical')} · Major ${count('major')} · Minor ${count('minor')} · Nit ${count('nit')}${summary.model ? ` · Model ${summary.model}` : ''} · Elapsed ${(summary.elapsedMs / 1000).toFixed(1)}s

${fresh.length ? `Posted ${fresh.length} new inline comment${fresh.length === 1 ? '' : 's'}.` : 'No new inline comments; every finding above was already posted.'} ${range}`;
  const current = previousReview(exec, repo, pr, summary.author);
  const endpoint = current
    ? `repos/${repo}/issues/comments/${current.id}`
    : `repos/${repo}/issues/${pr}/comments`;
  reviewGh(exec, ['api', endpoint, '--method', current ? 'PATCH' : 'POST', '--input', '-'], {
    body,
  });
  return fresh.length;
}
