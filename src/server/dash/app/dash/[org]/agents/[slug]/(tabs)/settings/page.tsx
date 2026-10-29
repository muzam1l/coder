import { dynamic } from '@wular/pnext/dynamic';

import { load } from '@/api/load';
import { Settle } from '@/comps/frame/stream';
import { loadAgent, loadRunDefaults } from '@/api/load';
import { runnerOptions } from '@/app/dash/[org]/tasks/composer-data';

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
  const run = loadRunDefaults(request);
  const catalog = load(request)
    .integrations.list()
    .catch(() => []);
  // A failed list fails the form: Save replaces settings whole, so a missing list would wipe them.
  const connections = load(request)
    .connections.list()
    .then(rows => rows.filter(row => !row.owner && !row.agent));
  const runners = load(request)
    .runners.list()
    .then(rows => rows.items);

  return (
    <Settle
      load={() =>
        Promise.all([agent, run, runners, catalog, connections]).then(
          ([row, { shape }, rows, integrations, workspace]) => (
            <AgentSettingsForm
              agent={row}
              catalog={integrations}
              shape={shape}
              runners={runnerOptions(rows)}
              connections={workspace}
            />
          ),
        )
      }
    />
  );
}
