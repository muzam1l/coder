import './runners-list.css';
import './mcp-list.css';
import './engines-list.css';
import './credentials-list.css';
import './list.css';
import { dynamic } from '@wular/pnext/dynamic';
import { notFound } from '@wular/pnext/navigation';
import { DEFAULT_CONFIG } from '@coder/core/config';

import { load } from '@/api/load';
import { Settle, Stream } from '@/comps/frame/stream';
import { Loading } from '@/comps/ui/card';
import { SETTINGS } from '@/app/dash/settings/settings-head';
import { localServer } from '@/api/types';
import { Credentials } from './credentials';

const ADMIN_ROLES = new Set(['owner', 'admin']);

const ModelsList = dynamic(() => import('./models-list').then(m => m.ModelsList));
const McpList = dynamic(() => import('./mcp-list').then(m => m.McpList));
const EnginesList = dynamic(() => import('./engines-list').then(m => m.EnginesList));
const RunnersList = dynamic(() => import('./runners-list').then(m => m.RunnersList));

/** One settings tab. */
export default async function SettingsTabPage({
  request,
  params,
}: {
  request?: Request;
  params: Promise<Record<string, string | string[]>>;
}) {
  if (!request) return null;
  const { tab } = await params;
  if (!SETTINGS.some(item => item.tab === tab)) notFound();
  if (tab === 'credentials') return <Credentials request={request} />;

  if (tab === 'models') {
    const models = load(request).models.list();
    const config = load(request).config.get();
    const me = load(request).me();
    const credentials = load(request).credentials.list();
    return (
      <Settle
        load={async () => {
          const [list, shape, who] = await Promise.all([models, config, me]);
          const local = localServer(who);
          return (
            <ModelsList
              first={list}
              config={shape}
              credentials={local ? null : await credentials}
              admin={!who.user || ADMIN_ROLES.has(who.organization?.role ?? '')}
            />
          );
        }}
      />
    );
  }

  if (tab === 'mcp') {
    const rows = load(request).mcp.list();
    return <Settle load={() => rows.then(first => <McpList first={first} />)} />;
  }

  if (tab === 'engines') {
    const config = load(request).config.get();
    return (
      <Settle
        load={() =>
          config.then(first => (
            <EnginesList first={first} defaults={DEFAULT_CONFIG.engines ?? {}} />
          ))
        }
      />
    );
  }

  const runners = load(request).runners.list();
  const me = load(request).me();

  return (
    <Stream
      fallback={<Loading label="Loading runners" h={188} />}
      load={() =>
        Promise.all([runners, me]).then(([first, who]) => <RunnersList first={first} me={who} />)
      }
    />
  );
}
