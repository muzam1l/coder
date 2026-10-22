import type {
  Access,
  MessageDraft,
  MessagePlace,
  PlatformEvent,
  Space,
  ToolServer,
} from '../types';

export async function canWriteLinear(
  event: PlatformEvent,
  token: string,
  request: typeof fetch = fetch,
): Promise<boolean> {
  if (!event.actor.id || !event.installationId)
    throw new Error('Linear event has no actor or workspace');
  const response = await request('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query:
        'query WorkspaceMember($id: String!) { user(id: $id) { id active guest app organization { id } } }',
      variables: { id: event.actor.id },
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  const body = (await response.json()) as {
    errors?: unknown[];
    data?: {
      user?: {
        id?: string;
        active?: boolean;
        guest?: boolean;
        app?: boolean;
        organization?: { id?: string };
      };
    };
  };
  const user = body.data?.user;
  if (
    !response.ok ||
    (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length > 0)) ||
    !user
  )
    throw new Error('Linear returned no valid workspace member');

  return (
    user.id === event.actor.id &&
    user.active === true &&
    user.guest === false &&
    user.app === false &&
    user.organization?.id === event.installationId
  );
}

/** An agent session's space: its issue's team, public only when Linear says so (`issue.team`). */
export async function linearSpace(
  event: PlatformEvent,
  token: string,
  request: typeof fetch = fetch,
): Promise<Space | undefined> {
  const issue = /^linear:([^:]+)/.exec(event.chat?.thread.id ?? '')?.[1];
  if (!issue) return undefined;
  const response = await request('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query:
        'query IssueTeam($issue: String!) { issue(id: $issue) { team { id private visibility } } }',
      variables: { issue },
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  const body = (await response.json()) as {
    errors?: unknown[];
    data?: { issue?: { team?: { id?: unknown; private?: unknown; visibility?: unknown } } };
  };
  const team = body.data?.issue?.team;
  if (
    !response.ok ||
    (Array.isArray(body.errors) && body.errors.length) ||
    typeof team?.id !== 'string'
  )
    throw new Error('Linear returned no issue team');

  return {
    kind: 'team',
    id: team.id,
    private: !(team.private === false && team.visibility === 'public'),
  };
}

/** Every member of a team (`team.members`, 100 a page). */
export async function linearMembers(
  space: Space,
  token: string,
  request: typeof fetch = fetch,
): Promise<string[]> {
  const members: string[] = [];
  let after: string | undefined;
  do {
    const response = await request('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        query:
          'query TeamMembers($team: String!, $after: String) { team(id: $team) { members(first: 100, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } } } }',
        variables: { team: space.id, after },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    const body = (await response.json()) as {
      errors?: unknown[];
      data?: {
        team?: {
          members?: {
            nodes?: Array<{ id?: unknown }>;
            pageInfo?: { hasNextPage?: boolean; endCursor?: string };
          };
        };
      };
    };
    const page = body.data?.team?.members;
    if (!response.ok || (Array.isArray(body.errors) && body.errors.length) || !page?.nodes)
      throw new Error('Linear returned no team members');
    members.push(...page.nodes.flatMap(node => (typeof node.id === 'string' ? [node.id] : [])));
    after = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : undefined;
  } while (after);

  return members;
}

export const LINEAR_PRESETS: Record<Access, string[]> = {
  'read-only': ['read'],
  auto: ['read', 'write'],
};

export function linearToolServer(tools: string[], _event: unknown, token: string): ToolServer {
  return {
    name: 'linear',
    url: `https://mcp.linear.app/mcp${tools.includes('write') ? '' : '/readonly'}`,
    headers: { Authorization: `Bearer ${token}` },
    credentialFields: { header: 'Authorization' },
  };
}

/** The bound adapter's agent activities. */
interface LinearActivities {
  postElicitation(
    threadId: string,
    body: string,
    options: Array<{ label: string; value: string }>,
  ): Promise<{ id?: string }>;
  postProgress(threadId: string, text: string): Promise<unknown>;
}

/** Buttons are a select elicitation whose pick comes back as a prompt holding the value. */
export async function postLinearMessage(
  { thread }: MessagePlace,
  { markdown: text, collapsed, buttons, hint, link }: MessageDraft,
): Promise<string | undefined> {
  const adapter = thread.adapter as unknown as LinearActivities;
  const markdown = [
    text,
    collapsed && `+++ ${collapsed.summary}\n\n${collapsed.markdown}\n\n+++`,
    hint,
    link && `[${link.label}](${link.url})`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const sent = buttons?.length
    ? await adapter.postElicitation(
        thread.id,
        markdown,
        buttons.map(button => ({ label: button.label, value: button.value })),
      )
    : ((await adapter.postProgress(thread.id, markdown)) as { id?: string });

  return sent.id;
}
