/** Platform events Coder failed to handle: kept a day for the agent's Usage page, and told to their thread once when asked directly. */
import { randomUUID } from 'node:crypto';
import { AgentLoadError } from '../../agent/load';

import type { AgentApp, AgentEvent, AgentTask } from '../../agent/types';
import { forInstallation, type ServerContext } from '../context';
import { directAsk } from './conversation';
import type { FailedDelivery, Store } from '../store/types';
import { DELIVERY_TTL_MS, type Replies } from './events';

/** Most failures an agent read lists; the count covers them all. */
const LISTED = 50;

/** Keeps the failure in the workspace the installation is bound to, and tells the event's thread the first time if someone asked directly. */
export async function recordFailure(
  ctx: ServerContext,
  app: AgentApp,
  error: unknown,
  installation?: string,
  event?: AgentEvent,
  replies?: () => Promise<Replies> | Replies,
): Promise<void> {
  const integration = ctx.integrations[app.integration];
  const repo = event?.repo && `${event.repo.owner}/${event.repo.name}`;
  const url = event && (integration?.link?.(event) ?? (repo && integration?.repos?.url(repo)));
  let first = false;
  try {
    const tenant =
      (installation && (await forInstallation(ctx, `${app.id}:${installation}`))) || ctx;
    const failure: FailedDelivery = {
      at: (ctx.now ?? Date.now)(),
      organization: tenant.organizationId,
      integration: app.integration,
      app: app.id,
      agent: app.agent,
      error: (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 500),
      ...(event ? { type: event.type, delivery: event.deliveryId } : {}),
      ...(event?.chat ? { thread: event.chat.thread.id } : {}),
      ...(repo ? { repo } : {}),
      ...(url ? { url } : {}),
    };
    const key = `failed:${app.agent}:${event?.deliveryId ?? randomUUID()}`;
    first = await tenant.store.create('delivery', key, failure, { ttlMs: DELIVERY_TTL_MS });
  } catch (cause) {
    console.error(`coder server: could not record a failed delivery for ${app.id}`, cause);
  }
  if (!first || !replies || !integration || !event || !directAsk(integration, event)) return;

  try {
    await (
      await replies()
    ).problem(
      error instanceof AgentLoadError
        ? error.message
        : `Coder could not handle this message. If you run this server, check its logs. Otherwise report it at ${ctx.config.issuesUrl}.`,
    );
  } catch (cause) {
    console.error(`coder server: could not tell ${app.id}'s thread about a failed delivery`, cause);
  }
}

/** A platform task that ended before its agent answered: a direct ask's thread gets the failure reply once. */
export async function reportTaskFailure(
  ctx: ServerContext,
  task: AgentTask,
  error: unknown,
): Promise<void> {
  const event = task.event;
  if (!event || task.source !== event.integration) return;
  const app = await ctx.store.get('app', event.appId).catch(cause => {
    console.error(`coder server: could not report the failure of task ${task.id}`, cause);
  });
  if (!app) return;
  const { eventReplies } = await import('../chat');

  await recordFailure(ctx, app, error, event.installationId, event, () =>
    eventReplies(ctx, app, event),
  );
}

/** An agent's failed deliveries of the last day: how many, and the newest. */
export async function failedDeliveries(
  store: Store,
  agent: string,
): Promise<{ failed: number; recent: FailedDelivery[] }> {
  const rows = await store.list<FailedDelivery>('delivery', { prefix: `failed:${agent}:` });
  const recent = rows.map(row => row.value).sort((a, b) => b.at - a.at);

  return { failed: recent.length, recent: recent.slice(0, LISTED) };
}
