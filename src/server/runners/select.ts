/** Which runner a task runs on, and the instance behind a stored runner record. */
import type { AgentTask, RunnerKind } from '../../agent/types';
import type { RunnerRecord } from '../store/types';
import type { ServerContext } from '../context';
import { decryptSecret } from '../store/secrets';
import { createRunner, type Runner } from '.';
import { runnerSnapshots } from './kinds/vercel-sandbox';

export function visibleRunner(record: RunnerRecord, requestedBy?: string): boolean {
  return record.scope === 'workspace' || Boolean(requestedBy && record.owner === requestedBy);
}

export function serverRunnerId(ctx: ServerContext): string {
  return ctx.local ? 'local' : 'default';
}

export async function chooseRunner(
  ctx: ServerContext,
  options: { requestedBy?: string; runner?: string; agent?: string } = {},
): Promise<{ runner: RunnerKind; runnerId?: string }> {
  const named = options.runner ?? options.agent;
  if (named === serverRunnerId(ctx)) return { runner: ctx.config.runner };
  const rows = (
    await ctx.store.list('runner', {
      visibleTo: options.requestedBy,
      ...(named ? { runner: named } : { defaults: true }),
    })
  ).filter(
    ({ value }) =>
      visibleRunner(value, options.requestedBy) &&
      (ctx.local || (value.kind !== 'local' && value.kind !== 'local-docker')),
  );
  const found = named
    ? rows.find(({ id, value }) => id === named || value.name === named)
    : (rows.find(({ value }) => value.scope === 'personal' && value.default) ??
      rows.find(({ value }) => value.scope === 'workspace' && value.default));
  if (named && !found) throw new Error(`Unknown runner "${named}".`);

  return found ? { runner: found.value.kind, runnerId: found.id } : { runner: ctx.config.runner };
}

export function recordRunner(ctx: ServerContext, record: RunnerRecord, id?: string): Runner {
  const config = {
    ...record.config,
    ...decryptSecret<Record<string, string>>(ctx.config, record.secret),
  };
  return createRunner(record.kind, {
    workDir: ctx.config.workDir,
    config,
    fetch: ctx.fetch,
    sandbox: {
      ...(id
        ? {
            snapshots: runnerSnapshots(ctx.store, `runner:${id}:`),
          }
        : {}),
    },
  });
}

export async function taskRunner(
  ctx: ServerContext,
  task: Pick<AgentTask, 'runner' | 'runnerId'>,
): Promise<Runner | undefined> {
  if (!task.runnerId) return ctx.runners[task.runner];

  const record = await ctx.store.get('runner', task.runnerId);
  if (
    !record ||
    record.kind !== task.runner ||
    (!ctx.local && (record.kind === 'local' || record.kind === 'local-docker'))
  ) {
    ctx.settings?.runnerInstances?.delete(task.runnerId);
    return undefined;
  }

  decryptSecret(ctx.config, record.secret);

  const instances = ((ctx.settings ??= {}).runnerInstances ??= new Map());
  const signature = JSON.stringify([record.kind, record.config, record.secret]);
  let instance = instances.get(task.runnerId);
  if (instance?.signature !== signature) {
    instance = { signature, runner: recordRunner(ctx, record, task.runnerId) };
    instances.set(task.runnerId, instance);
  }

  return instance!.runner;
}
