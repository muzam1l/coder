/** Conversation context the receiver gathers before dispatch. */
import { repositoryReader } from '../../integrations';
import type { Integration } from '../../integrations/types';
import type { Agent, AgentEvent, Installation, TaskContext } from '../../agent/types';
import type { ServerContext } from '../context';
import { cachedFile } from '../agents/repo';
import type { TokenSource } from './context';

/** A thread Coder started a task in, so later plain messages there are a conversation. */
export function conversationKey(appId: string, installationId: string, thread: string): string {
  return `thread:${appId}:${installationId}:${thread}`;
}

/** Config-repo instructions and who asked; every part is best-effort. */
export async function buildContext(
  ctx: ServerContext,
  integration: Integration,
  installation: Installation,
  event: AgentEvent,
  tokens: TokenSource,
  agent: Agent,
  member?: { name: string; email: string } | null,
): Promise<TaskContext> {
  const context: TaskContext = {};
  const reader = repositoryReader(ctx.integrations);
  const configRepo = installation.settings?.configRepo;
  const instructions =
    reader && configRepo
      ? await tokens(reader.id)
          .then(access =>
            access
              ? cachedFile(ctx, reader, access, configRepo, `.coder/${agent.id}.md`)
              : undefined,
          )
          .catch(() => undefined)
      : undefined;
  if (instructions?.trim()) {
    context.instructions = instructions.trim();
    context.repository = configRepo;
  }
  if (member) context.user = { name: member.name, email: member.email };
  else if (member === undefined && ctx.auth && event.actor.id) {
    const user = await ctx.auth.linkedUser(integration.id, event.actor.id).catch(() => undefined);
    if (user) context.user = { name: user.name, email: user.email };
  }

  return context;
}
