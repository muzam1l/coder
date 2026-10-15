/** Where a Slack message sits in its thread, and what was said there since the agent's last turn, through one `conversations.replies` call each. */
import type { AgentEvent, ConversationAccess, ConversationFacts } from '../types';

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

export async function slackConversation(
  event: AgentEvent,
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
