/** How a pull request review reads where it is posted: its body, inline comments and links. */
import { DEFAULT_SERVER } from '../../client/auth/session';
import type { PullRequestReviews, ReviewTarget } from '../../integrations/types';

/** A finding as posted: a changed line, its severity, a short title (`summary`) and how it fails. */
export interface ReviewFinding {
  file: string;
  line: number;
  start_line?: number;
  severity: 'critical' | 'major' | 'minor' | 'nit';
  summary: string;
  failure_scenario: string;
  fingerprint: string;
  inline?: boolean;
}

/** Where a posted review links: Coder, the task's page, and the base URL of its images; `from` names who posted it. */
export interface ReviewLinks {
  from: 'cloud' | 'cli';
  coder: string;
  images: string;
  task?: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** A cloud runner's links: images from its server, unless GitHub cannot fetch them there (loopback or plain HTTP). */
export function reviewLinks(server: string, dashboard?: string, task?: string): ReviewLinks {
  const url = new URL(server);
  const images =
    url.protocol === 'https:' && !LOCAL_HOSTS.has(url.hostname) ? url.origin : DEFAULT_SERVER;

  return {
    from: 'cloud',
    coder: dashboard || url.origin,
    images: `${images}/assets/review`,
    ...(task ? { task } : {}),
  };
}

export interface ReviewPost {
  note: string;
  target: ReviewTarget;
  findings: ReviewFinding[];
  /** The reviewer's own markdown above the list; may be empty. */
  body: string;
  links: ReviewLinks;
}

const picture = (images: string, name: string, alt: string) =>
  `<picture><source media="(prefers-color-scheme: dark)" srcset="${images}/${name}-dark.svg"><img align="absmiddle" alt="${alt}" src="${images}/${name}-light.svg"></picture>`;

const capital = (word: string) => word[0]!.toUpperCase() + word.slice(1);

/** Breaks every tag, link, image, reference definition, character reference and mention in model text, code spans included. */
const neutral = (text: string) =>
  text
    .replace(/<([A-Za-z/!?])/g, '<\u200b$1')
    .replace(/\]\(/g, ']\u200b(')
    .replace(/\]:/g, ']\u200b:')
    .replace(/!\[/g, '!\u200b[')
    .replace(/&([#A-Za-z])/g, '&\u200b$1')
    .replace(/@([\w-])/g, '@\u200b$1');

/** Model-written markdown: it adds no HTML, link, image or mention. */
const guarded = (text: string) => neutral(text.trim());

const PUNCTUATION = /[!-/:-@[-`{-~]/;

/** A model-written title on one line, read as CommonMark does: code spans stay, every other bracket, backtick and stray backslash is escaped, so it cannot leave its own link. */
const title = (text: string) => {
  const line = neutral(text.replace(/\s+/g, ' ').trim());
  let label = '';
  for (let at = 0; at < line.length;) {
    const char = line[at]!;
    if (char === '\\') {
      const next = line[at + 1];
      const pair = next !== undefined && PUNCTUATION.test(next);
      label += pair ? `\\${next}` : '\\\\';
      at += pair ? 2 : 1;
    } else if (char === '`') {
      const open = line.slice(at).match(/^`+/)![0];
      const runs = /`+/g;
      runs.lastIndex = at + open.length;
      let close: RegExpExecArray | null;
      while ((close = runs.exec(line)) && close[0].length !== open.length);
      label += close ? line.slice(at, runs.lastIndex) : open.replace(/`/g, '\\`');
      at = close ? runs.lastIndex : at + open.length;
    } else {
      label += char === '[' || char === ']' ? `\\${char}` : char;
      at += 1;
    }
  }

  return label;
};

/** `text` as one code span, its fence longer than any backtick run inside. */
const codeSpan = (text: string) => {
  const flat = text.replace(/[\r\n]+/g, ' ');
  const fence = '`'.repeat(Math.max(0, ...(flat.match(/`+/g) ?? []).map(run => run.length)) + 1);
  const pad = /^`|`$/.test(flat) ? ' ' : '';
  return `${fence}${pad}${flat}${pad}${fence}`;
};

const commit = (repo: string, sha: string) =>
  `<a href="https://github.com/${repo}/commit/${sha}"><code>${sha.slice(0, 7)}</code></a>`;

const range = (target: Pick<ReviewTarget, 'repo' | 'headSha' | 'since'>) =>
  target.since
    ? `<a href="https://github.com/${target.repo}/compare/${target.since}..${target.headSha}"><code>${target.since.slice(0, 7)}..${target.headSha.slice(0, 7)}</code></a>`
    : commit(target.repo, target.headSha);

function footer(links: ReviewLinks): string {
  return [
    `<a href="${links.coder}">${picture(links.images, `btn-${links.from}`, `Posted by coder ${links.from}`)}</a>`,
    ...(links.task
      ? [`<a href="${links.task}">${picture(links.images, 'btn-task', 'View task')}</a>`]
      : []),
  ].join(' ');
}

/** The review body: the reviewer's note and body, a force-push warning, the findings list headed by the reviewed range, links, and the reviewed head. */
export function reviewBody(review: ReviewPost, threads: Map<string, string> = new Map()): string {
  const { target, findings, links } = review;
  const note = review.note?.replace(/\s+/g, ' ').trim() ?? '';
  const heading = note.length > 200 ? `${note.slice(0, 199)}…` : note;
  const reviewed = `Reviewed ${range(target)}`;
  const list = findings.length
    ? [
        '<details open>',
        `<summary>${reviewed}: <b>${findings.length} issue${findings.length === 1 ? '' : 's'}</b></summary>`,
        '',
        ...findings.map(finding => {
          const thread = finding.inline === false ? undefined : threads.get(finding.fingerprint);
          const label = title(finding.summary);
          // A linked title leads to the full path; one without a thread shows it.
          const heading = thread ? `[${label}](${thread})` : label;
          const file = thread ? finding.file.split('/').pop() : finding.file;
          return `- ${picture(links.images, `sev-${finding.severity}`, capital(finding.severity))} ${heading} <sub>${codeSpan(`${file}:${finding.start_line ? `${finding.start_line}-` : ''}${finding.line}`)}</sub>`;
        }),
        '',
        '</details>',
      ].join('\n')
    : '';

  return [
    title(heading) || (!review.body.trim() && !findings.length ? 'Nothing to report.' : ''),
    guarded(review.body),
    target.forcePushed && target.since
      ? `> [!WARNING]\n> The branch no longer contains <code>${target.since.slice(0, 7)}</code> after a force-push. This review covers lines changed since it.`
      : '',
    list || reviewed,
    footer(links),
    `<!-- coder-review head=${target.headSha} -->`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** One finding's inline comment: its title, severity and failure, with the marker that keeps it from posting twice. */
export function inlineComment(finding: ReviewFinding, images: string): string {
  return [
    `### ${title(finding.summary)}`,
    picture(images, `sev-${finding.severity}`, capital(finding.severity)),
    guarded(finding.failure_scenario),
    `<!-- coder-review:fp=${finding.fingerprint} -->`,
  ].join('\n\n');
}

/** Posts a review: inline comments for findings the author has not posted before, and one body linking every thread. */
export async function postReview(
  platform: PullRequestReviews,
  review: ReviewPost,
  token: string,
  request?: typeof fetch,
): Promise<{ url: string; posted: number }> {
  const { target } = review;
  const threads = await platform.threads(target, token, request);
  const fresh = review.findings.filter(
    finding => finding.inline !== false && !threads.has(finding.fingerprint),
  );
  const comments = fresh.map(finding => ({
    file: finding.file,
    line: finding.line,
    ...(finding.start_line ? { startLine: finding.start_line } : {}),
    body: inlineComment(finding, review.links.images),
  }));
  try {
    const posted = await platform.post(
      target,
      { comments, body: created => reviewBody(review, new Map([...threads, ...created])) },
      token,
      request,
    );

    return { url: posted.url, posted: fresh.length };
  } catch (error) {
    if (!comments.length) throw error;
    // The platform refuses a whole review when one comment misses its diff; the body alone still lists every finding.
    console.error(
      `coder review: posting ${target.repo}#${target.number} again without inline comments`,
      error,
    );
    const posted = await platform.post(
      target,
      { comments: [], body: () => reviewBody(review, threads) },
      token,
      request,
    );

    return { url: posted.url, posted: 0 };
  }
}
