import { type ComposerOptions } from '../../client/types';
import { defaultAgent } from '../../agent/load';
import { builtinFlowsDir, flowsIn } from '../../flow/discover';
import { type ServerContext } from '../context';
import { agentRecords, prepareAgent } from '../agents/catalog';
import { effectiveConfig, shownConfig } from '../settings/config';
import { localFolders } from '../settings/folders';
import { modelList } from '../settings/models';
import { runnerItems } from '../settings/runners';
import { json } from '../routes/http';

/** `GET /admin/composer`: everything the New task composer offers, read in one handler. */
export async function composerOptions(req: Request, ctx: ServerContext): Promise<Response> {
  const { now, local } = await prepareAgent(ctx);
  const [records, config, runners] = await Promise.all([
    agentRecords(ctx, local, { limit: 200 }),
    shownConfig(ctx),
    ctx.store.list('runner'),
  ]);

  const preferred = defaultAgent();
  const agents = records
    .filter(record => !record.settings?.disabled)
    .sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred))
    .map(({ id, name }) => ({ id, name, ...(id === preferred ? { default: true as const } : {}) }));
  const effective = effectiveConfig(ctx, config);
  const repos = Object.values(ctx.integrations).find(integration => integration.repos);

  return json({
    agents,
    ...(effective.chain?.[0] ? { engine: effective.chain[0] } : {}),
    engines: effective.engines ?? {},
    models: modelList(config),
    runners: runnerItems(ctx, runners, now).map(({ id, name, default: chosen }) => ({
      id,
      name,
      default: chosen,
    })),
    flows: flowsIn(builtinFlowsDir(), 'builtin').map(flow => flow.name),
    ...(ctx.local ? { folders: localFolders(ctx.local.cwd) } : {}),
    ...(repos ? { connectLabel: repos.installLabel ?? `Connect ${repos.id}` } : {}),
  } satisfies ComposerOptions);
}
