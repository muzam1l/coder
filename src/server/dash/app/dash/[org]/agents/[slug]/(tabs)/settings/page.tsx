import { dynamic } from '@wular/pnext/dynamic';

import { load, orgOf } from '@/api/load';
import { Settle } from '@/comps/frame/stream';
import { loadAgent } from '@/api/load';
import { NO_MODELS, modelsByEngine } from '@/app/dash/[org]/settings/model-options';
import { runnerOptions } from '@/app/dash/[org]/tasks/composer-data';
import { DEFAULT_ENGINE } from '@coder/core/defaults';
import { NeedsCredential } from '@/app/dash/[org]/tasks/composer';

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
  const catalog = load(request)
    .integrations.list()
    .catch(() => []);
  const connections = load(request)
    .connections.list()
    .then(
      rows => rows.filter(row => !row.owner),
      () => [],
    );
  const runners = load(request)
    .runners.list()
    .then(
      rows => rows.items,
      () => [],
    );

  return (
    <Settle
      load={() =>
        Promise.all([agent, models, config, runners, catalog, connections]).then(
          ([row, shape, shown, rows, integrations, workspace]) => (
            <>
              {row.needsModel ? (
                <NeedsCredential reason="Agents need a model credential to run." label={row.name} />
              ) : null}
              <AgentSettingsForm
                agent={row}
                catalog={integrations}
                models={modelsByEngine(shape)}
                defaults={{
                  engine: shown?.effective.chain?.[0] ?? DEFAULT_ENGINE,
                  engines: shown?.effective.engines ?? {},
                }}
                runners={runnerOptions(rows)}
                connections={workspace}
              />
            </>
          ),
        )
      }
    />
  );
}
