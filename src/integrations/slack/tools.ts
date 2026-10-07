import { type ToolContext, type ToolSet } from '../types';

const HISTORY = ['channels:history', 'groups:history', 'im:history', 'mpim:history'];
const CONVERSATIONS = ['channels:read', 'groups:read', 'im:read', 'mpim:read'];

/** Web API methods `slack_api` may call, each with the bot scopes that allow it (any one). */
export const SLACK_READ_METHODS: Record<string, string[]> = {
  'conversations.history': HISTORY,
  'conversations.replies': HISTORY,
  'conversations.info': CONVERSATIONS,
  'conversations.list': CONVERSATIONS,
  'users.info': ['users:read'],
  'users.list': ['users:read'],
  'reactions.get': ['reactions:read'],
};
export const SLACK_WRITE_METHODS: Record<string, string[]> = {
  'chat.postMessage': ['chat:write'],
  'reactions.add': ['reactions:write'],
};
const THREAD_FIELDS: Record<string, string> = {
  'chat.postMessage': 'thread_ts',
  'reactions.add': 'timestamp',
};
const SCOPES = { ...SLACK_READ_METHODS, ...SLACK_WRITE_METHODS };

/** Calls one Slack Web API method the task's method list allows; the app's manifest requests its scopes. */
export async function slackApi(
  ctx: ToolContext,
  method: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const allowed = ctx.tools ?? [];
  if (!allowed.includes(method) || !SCOPES[method])
    throw new Error(
      `Slack method ${method} is not allowed for this task; allowed: ${allowed.join(', ') || 'none'}`,
    );
  if (method in SLACK_WRITE_METHODS) {
    // The task's Chat SDK thread: `slack:<channel>:<thread ts>`.
    const [, channel, thread] = (ctx.scope?.thread ?? '').split(':');
    if (!channel || args.channel !== channel)
      throw new Error('This task may only write to its connected channel.');
    const field = Object.hasOwn(THREAD_FIELDS, method) ? THREAD_FIELDS[method] : undefined;
    if (!thread || !field || args[field] !== thread || args.reply_broadcast)
      throw new Error('This task may only write to its triggering thread.');
  }
  const { callSlackApi } = await import('@chat-adapter/slack/api');
  const data = await callSlackApi(method, args, {
    token: ctx.token,
    fetch: ctx.fetch,
    contentType: 'json',
  });
  if (data.error === 'missing_scope')
    throw new Error(
      `Slack method ${method} needs the ${SCOPES[method]!.join(' or ')} scope, which this app does not have`,
    );
  if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error}`);
  return data;
}

export const SLACK_TOOLS: ToolSet = {
  slack_api: {
    description:
      'Call a Slack Web API method, such as conversations.replies or chat.postMessage, with its JSON arguments. Only the methods this task allows work; others fail with the allowed list.',
    inputSchema: {
      type: 'object',
      properties: { method: { type: 'string' }, args: { type: 'object' } },
      required: ['method'],
    },
    handler: (a, ctx) =>
      slackApi(ctx, String(a.method ?? ''), (a.args ?? {}) as Record<string, unknown>),
  },
};
