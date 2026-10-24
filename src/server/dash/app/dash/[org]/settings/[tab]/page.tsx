import './runners-list.css';
import './connections-list.css';
import './credentials-list.css';
import './list.css';
import { dynamic } from '@wular/pnext/dynamic';
import { notFound } from '@wular/pnext/navigation';

import { createUrl, load } from '@/api/load';
import { stepOf } from '@/app/dash/[org]/agents/[slug]/(tabs)/platforms/platform-state';
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
const OutcomeToast = dynamic(() =>
  import('@/app/dash/[org]/setup/outcome-toast').then(m => m.OutcomeToast),
);
const AdvancedList = dynamic(() => import('./advanced-list').then(m => m.AdvancedList));
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
    // One page holds every agent: the Install menu's agents per platform, and each built-in agent's step for the Workspace column.
    const page = load(request)
      .agents.list({ cursor: '', limit: 200, apps: true })
      .catch(() => ({ items: [], apps: [], installations: [] }));
    const agents = page.then(({ items }) =>
      items.map(({ id, name, platforms, source }) => ({
        id,
        name,
        platforms: platforms.map(each => each.id),
        ...(source === 'builtin' ? { builtin: true } : {}),
      })),
    );
    const builtins = page.then(({ items, apps, installations }) =>
      items
        .filter(row => row.source === 'builtin')
        .map(row => {
          const own = apps.filter(app => app.agent === row.id);
          const platforms = Object.keys(row.definition?.integrations ?? {});
          return {
            id: row.id,
            name: row.name,
            steps: Object.fromEntries(
              platforms.map(platform => [
                platform,
                stepOf(platform, own, installations, createUrl(row, own, platform)),
              ]),
            ),
          };
        }),
    );
    const search = new URL(request.url).searchParams;
    const outcome = readOutcome(search);
    const signIn = search.get('outcome');
    return (
      <Settle
        load={async () => {
          const [first, integrations, who, used, own] = await Promise.all([
            rows,
            catalog,
            me,
            agents,
            builtins,
          ]);
          return (
            <>
              {outcome ? (
                <OutcomeToast
                  ok={succeeded(outcome)}
                  title={
                    succeeded(outcome)
                      ? `${outcomeName(outcome, integrations)} connected${outcome.account ? ` as ${outcome.account}` : ''}`
                      : outcomeTitle(outcome, outcomeName(outcome, integrations))
                  }
                  text={
                    succeeded(outcome)
                      ? SIGN_IN.connected!
                      : outcomeText(outcome, outcomeName(outcome, integrations))
                  }
                />
              ) : null}
              {signIn ? (
                <OutcomeToast
                  ok={signIn === 'connected'}
                  title={signIn === 'connected' ? 'Signed in' : 'Not signed in'}
                  text={SIGN_IN[signIn] ?? SIGN_IN_FAILED}
                />
              ) : null}
              <ConnectionsList
                first={first}
                catalog={integrations}
                local={localServer(who)}
                admin={isAdmin(who)}
                operator={who.operator === true}
                viewer={who.user?.name ?? undefined}
                agents={used}
                builtins={own}
              />
            </>
          );
        }}
      />
    );
  }

  if (tab === 'advanced') {
    const config = load(request).config.get();
    const me = load(request).me();
    return (
      <Settle
        load={() =>
          Promise.all([config, me]).then(([first, who]) => (
            <AdvancedList first={first} admin={isAdmin(who)} />
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
