import { randomUUID } from 'node:crypto';

import type {
  Access,
  ConversationAccess,
  ConversationFacts,
  PlatformEvent,
  Space,
  ToolServer,
} from '../types';

export function slackFetch(request: typeof fetch, installation?: string): typeof fetch {
  const users = new Map<string, Promise<Response>>();

  return (async (input, init) => {
    const outbound = new Request(input, init);
    if (
      new URL(outbound.url).origin !== 'https://slack.com' ||
      new URL(outbound.url).pathname !== '/api/users.info'
    )
      return request(input, init);
    const form = new URLSearchParams(await outbound.clone().text());
    const token =
      outbound.headers.get('authorization')?.replace(/^Bearer /, '') ?? form.get('token');
    const key = JSON.stringify([token, form.get('team_id') ?? installation, form.get('user')]);
    let pending = users.get(key);
    if (!pending) {
      pending = request(input, init)
        .then(async response => {
          const body = await response
            .clone()
            .json()
            .catch(() => undefined);
          if (!response.ok || body?.ok !== true) users.delete(key);
          return response;
        })
        .catch(error => {
          users.delete(key);
          throw error;
        });
      users.set(key, pending);
    }

    return (await pending).clone();
  }) as typeof fetch;
}

export async function canWriteSlack(
  event: PlatformEvent,
  token: string,
  request: typeof fetch = fetch,
): Promise<boolean> {
  const team = event.account ?? event.installationId;
  if (!team || !event.actor.id) throw new Error('Slack event has no workspace or actor');
  const response = await request('https://slack.com/api/users.info', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ user: event.actor.id, team_id: team }),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  const body = (await response.json()) as {
    ok?: boolean;
    user?: {
      id?: string;
      team_id?: string;
      deleted?: boolean;
      is_bot?: boolean;
      is_restricted?: boolean;
      is_ultra_restricted?: boolean;
      is_external?: boolean;
      enterprise_user?: { teams?: string[] };
    };
  };
  const user = body.user;
  if (!response.ok || body.ok !== true || !user)
    throw new Error('Slack returned no valid workspace member');

  return (
    user.id === event.actor.id &&
    user.deleted === false &&
    user.is_bot === false &&
    user.is_restricted === false &&
    user.is_ultra_restricted === false &&
    (user.is_external === undefined || user.is_external === false) &&
    (user.team_id === team ||
      (Array.isArray(user.enterprise_user?.teams) && user.enterprise_user.teams.includes(team)))
  );
}

async function conversations(
  method: 'info' | 'members',
  params: Record<string, string>,
  token: string,
  request: typeof fetch,
) {
  const response = await request(`https://slack.com/api/conversations.${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  const body = (await response.json()) as {
    ok?: boolean;
    channel?: { is_private?: boolean; is_im?: boolean; is_mpim?: boolean };
    members?: string[];
    response_metadata?: { next_cursor?: string };
  };
  if (!response.ok || body.ok !== true) throw new Error(`Slack conversations.${method} failed`);
  return body;
}

/** Whether a conversation shows to the whole workspace: a public channel, never a private one, group DM or DM (`conversations.info`). */
async function publicConversation(id: string, token: string, request: typeof fetch) {
  const { channel } = await conversations('info', { channel: id }, token, request);
  if (!channel) throw new Error('Slack returned no conversation');

  return channel.is_private === false && !channel.is_im && !channel.is_mpim;
}

/** An event's conversation with the privacy Slack gives it, for events without `channel_type` (`app_mention`). */
export async function slackSpace(
  event: PlatformEvent,
  token: string,
  request: typeof fetch = fetch,
): Promise<Space | undefined> {
  if (!event.space) return undefined;

  return { ...event.space, private: !(await publicConversation(event.space.id, token, request)) };
}

/** Every member of a conversation the bot is in (`conversations.members`, Tier 4, 200 a page). */
export async function slackMembers(
  space: Space,
  token: string,
  request: typeof fetch = fetch,
): Promise<string[]> {
  const members: string[] = [];
  let cursor = '';
  do {
    const page = await conversations(
      'members',
      { channel: space.id, limit: '200', ...(cursor ? { cursor } : {}) },
      token,
      request,
    );
    members.push(...(page.members ?? []));
    cursor = page.response_metadata?.next_cursor ?? '';
  } while (cursor);

  return members;
}

export function slackUninstalled(error: unknown): boolean {
  const code = (error as { data?: { error?: string } } | null)?.data?.error;
  return ['invalid_auth', 'account_inactive', 'token_revoked'].includes(code ?? '');
}

interface Reply {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  reply_count?: number;
  user_profile?: { display_name?: string; real_name?: string };
}

async function replies(
  access: ConversationAccess,
  params: Record<string, string>,
): Promise<Reply[]> {
  const token = await access.token();
  if (!token) return [];
  const response = await access.fetch('https://slack.com/api/conversations.replies', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  const body = (await response.json()) as { ok?: boolean; messages?: Reply[] };
  if (!response.ok || body.ok !== true) throw new Error('Slack returned no thread');

  return body.messages ?? [];
}

const sentAt = (ts: string) => new Date(Number(ts) * 1000).toISOString();

/** Where a Slack message sits in its thread, and what was said there since the agent's last turn, through one `conversations.replies` call each. */
export async function slackConversation(
  event: PlatformEvent,
  access: ConversationAccess,
): Promise<ConversationFacts> {
  const thread = /^slack:([^:]+):(\d+\.\d+)$/.exec(event.chat?.thread.id ?? '');
  const message = event.chat?.message;
  // A 1:1 DM has no start that matters.
  if (!thread || !message || event.chat?.thread.isDM) return {};
  const [, channel, root] = thread as unknown as [string, string, string];

  // A thread's first message is 0 with no call; a reply's position is the parent's reply count, read once on the first turn.
  if (access.after === undefined) {
    if (message.id === root) return { index: 0 };
    const [parent] = await replies(access, { channel, ts: root, limit: '1' });

    return parent?.reply_count === undefined ? {} : { index: parent.reply_count };
  }
  if (access.delivered) return {};

  const after = access.after;
  const rows = await replies(access, { channel, ts: root, oldest: after, limit: '1000' });
  const since = rows
    .filter(
      row => row.ts && row.ts !== root && row.ts !== message.id && row.ts > after && !row.bot_id,
    )
    .map(row => ({
      id: row.ts!,
      author: row.user_profile?.display_name || row.user_profile?.real_name || row.user || '',
      text: row.text ?? '',
      sentAt: sentAt(row.ts!),
    }));

  return { since };
}

export const SLACK_PRESETS: Record<Access, string[]> = {
  'read-only': ['read'],
  auto: ['read', 'write'],
};

export const SLACK_MCP_SERVER_INSTALL =
  'set -eu; arch=$(uname -m); case "$arch" in x86_64) arch=amd64; checksum=d1525962e9b9dbfdd2eaf48d0a81ca1eca7d8f1862b8d34931b812c850b3e568;; aarch64|arm64) arch=arm64; checksum=a307a48d16c2261346bdc257274cdcdb8b2027c867dc971b41d52cef36472c88;; *) exit 1;; esac; file=$(mktemp); trap \'rm -f "$file"\' EXIT; curl -fsSL "https://github.com/korotovsky/slack-mcp-server/releases/download/v1.3.0/slack-mcp-server-linux-$arch" -o "$file"; echo "$checksum  $file" | sha256sum -c -; install -m 755 "$file" /usr/local/bin/slack-mcp-server';

/** What a user's own Slack connection reaches. */
export const SLACK_USER_DESCRIPTION = "On the user's token; searches and reads everything the user can see.";

export function slackToolServer(
  tools: string[],
  _event: PlatformEvent | undefined,
  token: string,
  owner?: string,
): ToolServer {
  const readOnly = !tools.includes('write');
  // A member's own user token goes to Slack's MCP server, which takes user tokens only.
  if (owner)
    return {
      name: 'slack',
      url: 'https://mcp.slack.com/mcp',
      headers: { Authorization: `Bearer ${token}` },
      credentialFields: { header: 'Authorization' },
      readOnly,
      description: SLACK_USER_DESCRIPTION,
    };
  const cache = `/tmp/coder-slack-${randomUUID()}`;

  return {
    name: 'slack',
    command: 'slack-mcp-server',
    readOnly,
    description: 'On the bot token; reads the channels the bot is in and has no search.',
    instructions: [
      'Read: channels_list lists channels;',
      "conversations_history reads a channel's or DM's messages, including messages older than the conversation history the task's history tool returns;",
      "conversations_replies reads a thread's by its thread_ts.",
      'A channel_id is an id such as C0123, #channel-name, or @user for a DM.',
      'Write, when allowed: conversations_add_message posts to a channel or thread; the reaction tools add or remove an emoji reaction.',
    ].join(' '),
    args: ['--transport', 'stdio'],
    env: {
      SLACK_MCP_XOXB_TOKEN: token,
      SLACK_MCP_USERS_CACHE: `${cache}-users.json`,
      SLACK_MCP_CHANNELS_CACHE: `${cache}-channels.json`,
      SLACK_MCP_LOG_LEVEL: 'error',
      SLACK_MCP_ADD_MESSAGE_TOOL: readOnly ? '' : 'true',
      SLACK_MCP_REACTION_TOOL: readOnly ? '' : 'true',
      SLACK_MCP_ATTACHMENT_TOOL: 'true',
      SLACK_MCP_MARK_TOOL: readOnly ? '' : 'true',
    },
    credentialFields: { env: 'SLACK_MCP_XOXB_TOKEN' },
  };
}
