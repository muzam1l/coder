/** The tools Coder serves a task: review, escalate, and the conversation tools in a conversation. */
import path from 'node:path';
import process from 'node:process';

import { defineApp, defineCommand } from 'contextjsx';
import * as z from 'zod/mini';

import { arg, str, strList } from '../../../utils/args';
import { conversationCommands } from '../../../agent/context/tools';
import type { ReviewResult } from '../../../flow/builtin/review';
import { escalate } from '../../approvals';
import { startAsyncTool, type AsyncTool } from '../async';

interface ReviewInput {
  pr?: number;
  base?: string;
  path?: string[];
  exclude?: string[];
  depth?: 'low' | 'medium' | 'high';
}

const review: AsyncTool<ReviewInput> = {
  name: 'review',
  flow: 'review',
  limit: 5,
  platform: 'github',
  args: (input, cwd, author) => ({
    // A pull request's review compares its own base and posts on it.
    ...(input.pr !== undefined
      ? { pr: input.pr, ...(author ? { post: true, author } : {}) }
      : { base: input.base ?? 'HEAD' }),
    ...(input.path?.length ? { path: input.path } : {}),
    ...(input.exclude?.length ? { exclude: input.exclude } : {}),
    ...(input.depth ? { depth: input.depth } : {}),
    cwd,
  }),
  render: async (result, runId) => {
    const { renderReviewMarkdown } = await import('../../../flow/builtin/review');
    const reviewed = result as ReviewResult;
    const text = renderReviewMarkdown({ ...reviewed, runId });
    if (!reviewed.pr || reviewed.summary.url) return text;

    return `${text}\nNot posted. To post it on the pull request as the user, escalate \`coder review --post --run ${runId}\`.\n`;
  },
};

/** Tools that return at once; their result arrives later as a message. */
export const asyncTools: AsyncTool[] = [review];

/** Every tool whose answer arrives later as a message. */
const ASYNC_TOOL_NAMES = [...asyncTools.map(tool => tool.name), 'escalate'];

/** The task's record, which the tools act for. */
function taskDir(): string {
  const file = process.env.CODER_HISTORY_TASK;
  if (!file) throw new Error('CODER_HISTORY_TASK is not set');

  return path.dirname(file);
}

export const taskApp = defineApp({
  name: 'task',
  description: "This task's own tools.",
  commands: [
    defineCommand({
      name: 'escalate',
      description: [
        'Ask a human to approve actions your environment refused.',
        'Actions outside the sandbox are reviewed and may be refused; then take another way.',
        'If the task truly needs refused actions, escalate them all in one call with the exact commands, then continue or end your turn.',
        'The decision arrives as a message, in this turn while it runs, else in a new one.',
        'Approved actions stay approved for the rest of the task; run them outside the sandbox directly.',
      ].join(' '),
      args: {
        reason: str('One short sentence: what the actions are for.'),
        actions: strList(
          'Each action is exactly the command you will run once approved, nothing added; notes go in reason.',
        ),
      },
      access: 'read',
      run: ({ reason, actions }) => {
        const exact = (actions ?? []).map(action => action.trim()).filter(Boolean);
        if (!reason?.trim() || !exact.length) throw new Error('reason and actions are required');
        const dir = taskDir();
        const approval = escalate(process.cwd(), path.basename(dir), dir, {
          reason: reason.trim(),
          actions: exact,
        });

        return { approvalId: approval.id, status: 'pending' };
      },
    }),
    defineCommand({
      name: 'review',
      description: `Review your changes with a separate read-only reviewer that checks each finding against the repository. A read-only task's review posts only on its own event's pull request. One review at a time, ${review.limit} per turn.`,
      args: {
        pr: arg(
          z.optional(z.number()),
          "A pull request to review; on a Coder server the review is posted on it as the agent's app.",
        ),
        base: str('The ref to compare with; default HEAD, so only uncommitted changes.'),
        path: strList('Review only these paths, relative to the task directory.'),
        exclude: strList('Leave these paths out.'),
        depth: arg(
          z.optional(z.enum(['low', 'medium', 'high'])),
          'What to report: low only critical and major defects, high nits too; medium by default.',
        ),
        timeout: arg(z.optional(z.number()), 'Stop the review after this many seconds.'),
      },
      access: 'read',
      run: async ({ timeout, ...input }) => ({
        runId: await startAsyncTool(taskDir(), review, input, timeout),
        status: 'started',
      }),
    }),
    ...conversationCommands,
  ],
});

/** The task app serving only `tools`, its instructions naming the ones whose result arrives later. */
export function taskTools(tools: string[]) {
  const async = tools.filter(name => ASYNC_TOOL_NAMES.includes(name));

  return {
    ...taskApp,
    ...(async.length
      ? {
          instructions: [
            `${async.join(' and ')} ${async.length > 1 ? 'return' : 'returns'} at once;`,
            'the result arrives later as a message, in a new turn if yours has ended.',
          ].join(' '),
        }
      : {}),
    commands: taskApp.commands.filter(command => tools.includes(command.name)),
  };
}
