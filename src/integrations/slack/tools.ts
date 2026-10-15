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
  'files.getUploadURLExternal': ['files:write'],
  'files.completeUploadExternal': ['files:write'],
};
const SCOPES = { ...SLACK_READ_METHODS, ...SLACK_WRITE_METHODS };

/** Calls one Slack Web API method the task's method list allows; the app's manifest requests its scopes. */
export async function slackApi(
  ctx: ToolContext,
  method: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const allowed = ctx.tools ?? [];
  if (!Object.hasOwn(SCOPES, method)) throw new Error(`Unknown Slack method: ${method}`);
  if (!allowed.includes(method))
    throw new Error(
      `Slack method ${method} is not allowed for this task; allowed: ${allowed.join(', ') || 'none'}`,
    );
  if (method in SLACK_WRITE_METHODS) {
    // The task's Chat SDK thread: `slack:<channel>:<thread ts>`.
    const [, channel, thread] = (ctx.scope?.thread ?? '').split(':');
    const allocation = method === 'files.getUploadURLExternal';
    const destination = method === 'files.completeUploadExternal' ? args.channel_id : args.channel;
    if (!channel || (!allocation && (destination !== channel || Object.hasOwn(args, 'channels'))))
      throw new Error('This task may only write to its connected channel.');
    // A 1:1 DM is one conversation with no thread ts (`slack:D…:`), so the whole DM is its thread.
    const dm = !thread && channel.startsWith('D');
    if (
      (!thread && !dm) ||
      (!allocation && (!(dm || args.thread_ts === thread) || args.reply_broadcast))
    )
      throw new Error('This task may only write to its triggering thread.');
  }
  // An org-wide token acts only in the workspace the task's event came from.
  const within = ctx.scope?.within;
  const { callSlackApi } = await import('@chat-adapter/slack/api');
  const data = await callSlackApi(method, within ? { ...args, team_id: within } : args, {
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
      'Call a Slack Web API method, such as conversations.history or users.info, with its JSON arguments. Only the methods this task allows work; others fail with the allowed list.',
    inputSchema: {
      type: 'object',
      properties: { method: { type: 'string' }, args: { type: 'object' } },
      required: ['method'],
    },
    handler: (a, ctx) =>
      slackApi(ctx, String(a.method ?? ''), (a.args ?? {}) as Record<string, unknown>),
  },
};
