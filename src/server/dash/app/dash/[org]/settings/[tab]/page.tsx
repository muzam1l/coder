import './runners-list.css';
import './connections-list.css';
import './engines-list.css';
import './credentials-list.css';
import './list.css';
import '@/app/dash/[org]/setup/outcome.css';
import { dynamic } from '@wular/pnext/dynamic';
import { notFound } from '@wular/pnext/navigation';
import { DEFAULT_CONFIG } from '@coder/core/defaults';

import { load } from '@/api/load';
import { Settle, Stream } from '@/comps/frame/stream';
import { Loading } from '@/comps/ui/card';
import { SETTINGS } from '@/app/dash/[org]/settings/settings-head';
import { isAdmin, localServer } from '@/api/types';
import {
  outcomeName,
  outcomeText,
  outcomeTitle,
  readOutcome,
  succeeded,
} from '@/app/dash/[org]/setup/outcome';
import { Credentials } from './credentials';

const ADMIN_ROLES = new Set(['owner', 'admin']);

/** What a connection's sign-in says when it comes back with `outcome`. */
const SIGN_IN_FAILED = 'The sign-in did not finish. Try Reconnect.';
const SIGN_IN: Record<string, string> = {
  connected: 'Signed in. New tasks can use the connection.',
  denied: 'The sign-in was declined, so nothing changed.',
  failed: SIGN_IN_FAILED,
  'invalid-state': 'This sign-in link expired or was already used. Try Reconnect.',
};

const ModelsList = dynamic(() => import('./models-list').then(m => m.ModelsList));
const ConnectionsList = dynamic(() => import('./connections-list').then(m => m.ConnectionsList));
const OutcomeDialog = dynamic(() =>
  import('@/app/dash/[org]/setup/outcome-dialog').then(m => m.OutcomeDialog),
);
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
              admin={isAdmin(who)}
            />
          );
        }}
      />
    );
  }

  if (tab === 'connections') {
    const rows = load(request).connections.list();
    const catalog = load(request)
      .integrations.list()
      .catch(() => []);
    const me = load(request).me();
    const search = new URL(request.url).searchParams;
    const outcome = readOutcome(search);
    const signIn = search.get('outcome');
    return (
      <Settle
        load={async () => {
          const [first, integrations, who] = await Promise.all([rows, catalog, me]);
          return (
            <>
              {outcome ? (
                <OutcomeDialog
                  ok={succeeded(outcome)}
                  title={outcomeTitle(outcome, outcomeName(outcome, integrations))}
                  text={outcomeText(outcome, outcomeName(outcome, integrations))}
                  issues={who.server?.issuesUrl}
                />
              ) : null}
              {signIn ? (
                <OutcomeDialog
                  ok={signIn === 'connected'}
                  title={signIn === 'connected' ? 'Signed in' : 'Not signed in'}
                  text={SIGN_IN[signIn] ?? SIGN_IN_FAILED}
                  issues={who.server?.issuesUrl}
                />
              ) : null}
              <ConnectionsList
                first={first}
                catalog={integrations}
                local={localServer(who)}
                admin={isAdmin(who)}
                operator={who.operator === true}
              />
            </>
          );
        }}
      />
    );
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
