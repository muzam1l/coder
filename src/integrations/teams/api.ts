import type { AgentEvent } from '../types';

export async function canWriteTeams(
  event: AgentEvent,
  token: string,
  request: typeof fetch = fetch,
): Promise<boolean> {
  if (!event.chat?.thread.id || !event.actor.id || !event.installationId)
    throw new Error('Teams event has no conversation, actor or tenant');
  const { decodeThreadId } = await import('@chat-adapter/teams');
  const { conversationId, serviceUrl } = decodeThreadId(event.chat.thread.id);
  const endpoint = new URL(serviceUrl);
  if (!conversationId || endpoint.username || endpoint.password || endpoint.protocol !== 'https:')
    throw new Error('Teams event has no valid connector URL');
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/v3/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(event.actor.id)}`;
  endpoint.search = '';
  endpoint.hash = '';
  const response = await request(endpoint, {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  const member = (await response.json()) as { id?: string; tenantId?: string; userRole?: string };
  if (!response.ok || !member) throw new Error('Teams returned no valid tenant member');

  return (
    member.id === event.actor.id &&
    member.tenantId === event.installationId &&
    (member.userRole === 'owner' || member.userRole === 'member' || member.userRole === 'user')
  );
}
