import type { ToolContext, ToolSet } from '../types';

export const LINEAR_PRESETS = {
  observe: ['get_issue'],
  comment: [],
  write: ['get_issue', 'create_comment'],
};

async function query(
  ctx: ToolContext,
  tool: string,
  query: string,
  variables: Record<string, string>,
) {
  if (!ctx.tools?.includes(tool)) throw new Error(`Linear tool ${tool} is not allowed`);
  if (tool === 'create_comment' && ctx.scope?.thread)
    throw new Error('Commenting requires a native connection');
  const response = await ctx.fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
  const result = (await response.json()) as { data?: unknown; errors?: unknown[] };
  if (!response.ok || result.errors?.length || !result.data)
    throw new Error(`Linear request failed with status ${response.status}`);

  return result.data;
}

export const LINEAR_TOOLS: ToolSet = {
  get_issue: {
    description: 'Read a Linear issue by its UUID or identifier, such as ENG-123.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: async (args, ctx) => {
      if (typeof args.id !== 'string' || !args.id.trim())
        throw new Error('An issue ID is required');

      return query(
        ctx,
        'get_issue',
        'query($id: String!) { issue(id: $id) { id identifier title description url state { name } } }',
        { id: args.id },
      );
    },
  },
  create_comment: {
    description: 'Add a comment to an issue reached by the connected Linear account.',
    inputSchema: {
      type: 'object',
      properties: { issueId: { type: 'string' }, body: { type: 'string' } },
      required: ['issueId', 'body'],
    },
    handler: async (args, ctx) => {
      if (
        typeof args.issueId !== 'string' ||
        !args.issueId.trim() ||
        typeof args.body !== 'string' ||
        !args.body.trim()
      )
        throw new Error('An issue ID and comment are required');

      return query(
        ctx,
        'create_comment',
        'mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id url } } }',
        { issueId: args.issueId, body: args.body },
      );
    },
  },
};
