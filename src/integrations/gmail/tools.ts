import type { ToolContext, ToolSet } from '../types';

export const GMAIL_PRESETS = {
  observe: ['list_messages', 'read_message'],
  comment: [],
  write: ['list_messages', 'read_message', 'send_message'],
};

async function request(ctx: ToolContext, tool: string, path: string, body?: unknown) {
  if (!ctx.tools?.includes(tool)) throw new Error(`Gmail tool ${tool} is not allowed`);
  if (body && ctx.scope?.thread) throw new Error('Sending mail requires a native connection');
  const response = await ctx.fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${ctx.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Gmail request failed with status ${response.status}`);

  return response.json();
}

export const GMAIL_TOOLS: ToolSet = {
  list_messages: {
    description: 'Search messages in the connected mailbox using a Gmail search query.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, pageToken: { type: 'string' } },
    },
    handler: (args, ctx) => {
      const query = new URLSearchParams({ maxResults: '100' });
      if (typeof args.query === 'string') query.set('q', args.query);
      if (typeof args.pageToken === 'string') query.set('pageToken', args.pageToken);

      return request(ctx, 'list_messages', `messages?${query}`);
    },
  },
  read_message: {
    description: 'Read a message by its Gmail message ID.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: async (args, ctx) => {
      if (typeof args.id !== 'string' || !/^[a-z0-9]+$/i.test(args.id))
        throw new Error('Invalid Gmail message ID');

      return request(ctx, 'read_message', `messages/${args.id}?format=full`);
    },
  },
  send_message: {
    description: 'Send a base64url encoded RFC 822 email through the connected mailbox.',
    inputSchema: {
      type: 'object',
      properties: { raw: { type: 'string' }, threadId: { type: 'string' } },
      required: ['raw'],
    },
    handler: async (args, ctx) => {
      if (typeof args.raw !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(args.raw))
        throw new Error('Invalid encoded email');
      if (
        args.threadId !== undefined &&
        (typeof args.threadId !== 'string' || !/^[a-z0-9]+$/i.test(args.threadId))
      )
        throw new Error('Invalid Gmail thread ID');

      return request(ctx, 'send_message', 'messages/send', {
        raw: args.raw,
        ...(args.threadId ? { threadId: args.threadId } : {}),
      });
    },
  },
};
