/** Conversation context the receiver gathers before dispatch, and the note the agent hands back. */
import { repositoryReader } from '../../integrations';
import type { Integration } from '../../integrations/types';
import type { Agent, AgentEvent, AgentTask, Installation, TaskContext } from '../../agent/types';
import type { ServerContext } from '../context';

export const NOTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Store key for a thread's note: `<app>:<installation>:<Chat SDK thread id>`, so two agents' apps in one thread keep their own. */
export function threadKey(event: AgentEvent): string {
  return `${event.appId}:${event.installationId}:${event.chat?.thread.id ?? event.deliveryId}`;
}

async function readInstructions(
  reader: Integration,
  repo: string,
  agent: string,
  token: string,
): Promise<string | undefined> {
  return reader.repos!.readFile(repo, `.coder/${agent}.md`, token);
}

/** A platform task's note follows its thread; a dashboard or CLI task is its own thread. */
export function noteKey(task: Pick<AgentTask, 'id' | 'source' | 'event'>): string {
  return task.event && task.source === task.event.integration
    ? threadKey(task.event)
    : `task:${task.id}`;
}

/** Recent thread messages, stored note, and config-repo instructions; every part is best-effort. */
export async function buildContext(
  ctx: ServerContext,
  integration: Integration,
  installation: Installation,
  event: AgentEvent,
  tokens: Record<string, string>,
  agent: Agent,
  recent?: () => Promise<TaskContext['messages']>,
  member?: { name: string; email: string } | null,
): Promise<TaskContext> {
  const context: TaskContext = {};
  const reader = repositoryReader(ctx.integrations);
  const [messages, note, instructions] = await Promise.all([
    recent?.().catch(() => undefined),
    ctx.store.get('note', threadKey(event)).catch(() => undefined),
    reader && installation.settings?.configRepo && tokens[reader.id]
      ? readInstructions(
          reader,
          installation.settings.configRepo,
          agent.id,
          tokens[reader.id]!,
        ).catch(() => undefined)
      : undefined,
  ]);
  if (messages?.length) context.messages = messages;
  if (note) context.note = note;
  if (instructions?.trim()) context.instructions = instructions.trim();
  if (member) context.user = { name: member.name, email: member.email };
  else if (member === undefined && ctx.auth && event.actor.id) {
    const user = await ctx.auth.linkedUser(integration.id, event.actor.id).catch(() => undefined);
    if (user) context.user = { name: user.name, email: user.email };
  }

  return context;
}
