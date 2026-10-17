/** Conversation context the receiver gathers before dispatch. */
import type { Integration } from '../../integrations/types';
import type { AgentEvent, TaskContext } from '../../agent/types';
import type { ServerContext } from '../context';

/** A thread Coder started a task in, so later plain messages there are a conversation. */
export function conversationKey(appId: string, installationId: string, thread: string): string {
  return `thread:${appId}:${installationId}:${thread}`;
}

/** Who asked, best-effort. */
export async function buildContext(
  ctx: ServerContext,
  integration: Integration,
  event: AgentEvent,
  member?: { name: string; email: string } | null,
): Promise<TaskContext> {
  const context: TaskContext = {};
  if (member) context.user = { name: member.name, email: member.email };
  else if (member === undefined && ctx.auth && event.actor.id) {
    const user = await ctx.auth.linkedUser(integration.id, event.actor.id).catch(() => undefined);
    if (user) context.user = { name: user.name, email: user.email };
  }

  return context;
}
