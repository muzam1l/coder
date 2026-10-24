/** `coder review`: runs the built-in review flow and prints its result. */
import process from 'node:process';

import { CoderError } from '../core/errors';
import * as z from 'zod/mini';

import { arg, flag, modelOption, str, strList } from '../utils/args';
import { command } from '../cli';

export const commandReview = command({
  name: 'review',
  description: 'review changed code with a built-in flow',
  usage:
    'Review changed code with a read-only agent. Every reported finding is checked\nagainst the repository. Runs the built-in `review` flow. A local review covers\neverything since the merge-base with the origin default branch, including\nuncommitted and untracked files. Changed submodules are reviewed file by file.\nPR reviews can post one review with inline comments, never repeating a finding.\n\nRelated: `coder flow watch`, `coder docs review`.',
  access: 'write',
  approvalPolicy: 'deny',
  args: {
    base: str('local comparison base (default: merge-base with origin default)', '<ref>'),
    head: str('review commits through this ref only (default: the working tree)', '<ref>'),
    pr: str(
      'review a pull request by number (origin repo) or URL; GitHub via gh for now',
      '<n|url>',
    ),
    since: str('keep only PR files and hunks changed since this commit', '<sha>'),
    path: strList('review only this path, relative to cwd (repeatable)', '<p>'),
    exclude: strList('leave this path out, relative to cwd (repeatable)', '<p>'),
    post: flag('post the review on the pull request, as the signed-in gh user'),
    run: str('with --post, post this finished review run instead of reviewing again', '<id>'),
    md: flag('markdown output (the default)'),
    model: modelOption('for the review task (default: reviewModel)'),
    depth: arg(
      z.optional(z.enum(['low', 'medium', 'high'])),
      'what to report: low only critical and major, high nits too (default: medium)',
      '<low|medium|high>',
    ),
  },
  cli: {
    examples: [
      'coder review  # review the branch plus uncommitted work',
      'coder review --base main  # review everything since main locally',
      'coder review --path src --exclude src/gen  # review src without generated code',
      'coder review --pr 42 --post  # review and post to pull request 42',
      'coder review --depth high  # report nits too',
      'coder review --post --run <id>  # post a finished review run',
    ],
  },
  async run({ options, cwd }) {
    const { review } = await import('../flow/executor');

    if (options.json && options.md)
      throw new CoderError('invalid-option', '--json and --md are mutually exclusive.');
    const { run, md: _md, json: _json, ...args } = options;
    if (run === undefined) return review.run({ ...args, cwd });
    if (!args.post) throw new CoderError('invalid-option', '--run needs --post.');
    const { postReviewRun } = await import('../flow/builtin/review');

    return postReviewRun(run, cwd);
  },
  print: async result => {
    const { renderReviewMarkdown } = await import('../flow/builtin/review');

    process.stdout.write(renderReviewMarkdown(result));
  },
});
