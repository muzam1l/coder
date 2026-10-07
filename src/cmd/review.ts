/** `coder review`: runs the built-in review flow and prints its result. */
import process from 'node:process';

import * as z from 'zod/mini';

import { CoderError } from '../core/dispatch';
import type { ReviewResult } from '../flow/builtin/review';
import { baseOptions, flag, str, strList } from '../utils/args';
import { command } from '../cli';

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

export const commandReview = command({
  name: 'review',
  help: {
    usage:
      'coder review [--base <ref>] [--head <ref>] [--pr <n|url>] [--since <sha>] [--path <p>]... [--exclude <p>]... [--post] [--json|--md] [--engine <name>] [--model <alias|slug>] [--effort <low|medium|high>] [--cwd <dir>]',
    summary:
      'Review changed code with a read-only agent. Every reported finding is checked\nagainst the repository. Runs the built-in `review` flow. A local review covers\neverything since the merge-base with the origin default branch, including\nuncommitted and untracked files. Changed submodules are reviewed file by file.\nPR reviews can post deduplicated inline comments.',
    flags: [
      ['--base <ref>', 'local comparison base (default: merge-base with origin default)'],
      ['--head <ref>', 'review commits through this ref only (default: the working tree)'],
      [
        '--pr <n|url>',
        'review a pull request by number (origin repo) or URL; GitHub via gh for now',
      ],
      ['--since <sha>', 'keep only PR files and hunks changed since this commit'],
      ['--path <p>', 'review only this path, relative to cwd (repeatable)'],
      ['--exclude <p>', 'leave this path out, relative to cwd (repeatable)'],
      ['--post', 'post deduplicated inline comments and sticky PR summary'],
      ['--md', 'markdown output (the default)'],
      ['--engine <name>', 'codex, claude, or custom'],
      ['--model <alias|slug>', 'model for the review task'],
      ['--effort <low|medium|high>', 'reasoning effort and review depth (default: medium depth)'],
    ],
    examples: [
      ['coder review', 'review the branch plus uncommitted work'],
      ['coder review --base main', 'review everything since main locally'],
      ['coder review --path src --exclude src/gen', 'review src without generated code'],
      ['coder review --pr 42 --post', 'review and post to pull request 42'],
    ],
    seeAlso: 'flow watch · docs review',
  },
  options: {
    ...baseOptions,
    base: str,
    head: str,
    pr: str,
    since: str,
    path: strList,
    exclude: strList,
    post: flag,
    md: flag,
    engine: str,
    model: str,
    effort: z.optional(
      z.enum(['low', 'medium', 'high'], {
        error: 'expected "low", "medium", or "high"',
      }),
    ),
  },
  async run({ options, cwd }) {
    const { runFlowByName } = await import('../flow/executor');

    if (options.json && options.md)
      throw new CoderError('invalid-option', '--json and --md are mutually exclusive.');
    const run = await runFlowByName('review', { cwd, args: { ...options, cwd } });
    return { ...(run.result as ReviewResult), runId: run.runId };
  },
  print: result => process.stdout.write(renderReviewMarkdown(result)),
});
