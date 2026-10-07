import { dynamic } from '@wular/pnext/dynamic';

import { load } from '@/api/load';
import { Settle } from '@/comps/frame/stream';
import { loadAgent } from '@/api/load';
import { NO_MODELS, modelsByEngine } from '@/app/dash/settings/model-options';
import { runnerOptions } from '@/app/dash/tasks/composer-data';

const AgentSettingsForm = dynamic(() =>
  import('./agent-settings-form').then(m => m.AgentSettingsForm),
);

export default async function AgentSettingsPage({
  request,
  params,
}: {
  request?: Request;
  params: Promise<Record<string, string | string[]>>;
}) {
  if (!request) return null;
  const { slug: raw } = await params;
  const slug = Array.isArray(raw) ? raw[0]! : raw!;
  const agent = loadAgent(request, slug);
  const models = load(request)
    .models.list()
    .catch(() => NO_MODELS);
  const config = load(request)
    .config.get()
    .catch(() => undefined);
  const runners = load(request)
    .runners.list()
    .then(
      rows => rows.items,
      () => [],
    );

  return (
    <Settle
      load={() =>
        Promise.all([agent, models, config, runners]).then(([row, shape, shown, rows]) => (
          <AgentSettingsForm
            agent={row}
            models={modelsByEngine(shape)}
            defaults={{
              engine: shown?.effective.chain?.[0] ?? 'claude',
              engines: shown?.effective.engines ?? {},
            }}
            runners={runnerOptions(rows)}
          />
        ))
      }
    />
  );
}
