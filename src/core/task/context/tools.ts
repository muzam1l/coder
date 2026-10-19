/** The tools Coder serves every task: review, and the conversation tools in a conversation. */
import path from 'node:path';
import process from 'node:process';

import { defineApp, defineCommand } from 'contextjsx';
import * as z from 'zod/mini';

import { arg, str, strList } from '../../../utils/args';
import { conversationCommands } from '../../../agent/context/tools';
import { renderReviewMarkdown, type ReviewResult } from '../../../flow/builtin/review';
import { startAsyncTool, type AsyncTool } from '../async';

interface ReviewInput {
  base?: string;
  path?: string[];
  exclude?: string[];
}

const review: AsyncTool<ReviewInput> = {
  name: 'review',
  flow: 'review',
  limit: 5,
  args: (input, cwd) => ({
    base: input.base ?? 'HEAD',
    ...(input.path?.length ? { path: input.path } : {}),
    ...(input.exclude?.length ? { exclude: input.exclude } : {}),
    cwd,
  }),
  render: (result, runId) => renderReviewMarkdown({ ...(result as ReviewResult), runId }),
};

/** Tools that return at once; their result arrives later as a message. */
export const asyncTools: AsyncTool[] = [review];

/** The task's record, which the tools act for. */
function taskDir(): string {
  const file = process.env.CODER_HISTORY_TASK;
  if (!file) throw new Error('CODER_HISTORY_TASK is not set');

  return path.dirname(file);
}

export const taskApp = defineApp({
  name: 'coder',
  description:
    "This task's tools: review its changes; in a conversation, reply, react and read its history",
  commands: [
    defineCommand({
      name: 'review',
      description: `Review your changes with a separate read-only reviewer that checks each finding against the repository. One review at a time, ${review.limit} per task.`,
      args: {
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
