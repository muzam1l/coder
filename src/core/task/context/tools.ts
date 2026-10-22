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
}

const review: AsyncTool<ReviewInput> = {
  name: 'review',
  flow: 'review',
  limit: 5,
  args: (input, cwd) => ({
    // A pull request's review compares its own base and posts on it.
    ...(input.pr !== undefined ? { pr: input.pr, post: true } : { base: input.base ?? 'HEAD' }),
    ...(input.path?.length ? { path: input.path } : {}),
    ...(input.exclude?.length ? { exclude: input.exclude } : {}),
    cwd,
  }),
  render: async (result, runId) => {
    const { renderReviewMarkdown } = await import('../../../flow/builtin/review');
    return renderReviewMarkdown({ ...(result as ReviewResult), runId });
  },
};

/** Tools that return at once; their result arrives later as a message. */
export const asyncTools: AsyncTool[] = [review];

/** Every tool whose answer arrives later as a message. */
export const ASYNC_TOOL_NAMES = [...asyncTools.map(tool => tool.name), 'escalate'];

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
      description:
        "Ask a human to approve actions your environment refused, all in one request, collect all actions needed at once so you don't spam the user.",
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
      description: `Review your changes with a separate read-only reviewer that checks each finding against the repository. One review at a time, ${review.limit} per task.`,
      args: {
        pr: arg(z.optional(z.number()), 'A pull request to review and post the review on.'),
        base: str('The ref to compare with; default HEAD, so only uncommitted changes.'),
        path: strList('Review only these paths, relative to the task directory.'),
        exclude: strList('Leave these paths out.'),
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
