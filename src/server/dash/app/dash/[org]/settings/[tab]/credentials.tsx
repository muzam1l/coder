import { dynamic } from '@wular/pnext/dynamic';

import { load } from '@/api/load';
import { Settle } from '@/comps/frame/stream';
import { isAdmin, localServer } from '@/api/types';

// Hydrates as soon as the page does, so its sign-in buttons are live at once.
const CredentialsList = dynamic(() => import('./credentials-list').then(m => m.CredentialsList));
const EngineLogins = dynamic(() => import('./credentials-list').then(m => m.EngineLogins));
const TaskSecrets = dynamic(() => import('./secrets-list').then(m => m.TaskSecrets));

/** The credentials settings tab. */
export function Credentials({ request }: { request: Request }) {
  const params = new URL(request.url).searchParams;
  const me = load(request).me();
  const rows = load(request).credentials.list();
  const secrets = load(request)
    .connections.list()
    .then(list => list.filter(row => row.provider === 'env'));

  return (
    <Settle
      load={async () => {
        const [who, env] = await Promise.all([me, secrets]);
        const local = localServer(who);
        const list = <TaskSecrets first={env} local={local} admin={isAdmin(who)} />;
        if (local)
          return (
            <>
              <EngineLogins status={await load(request).engines.status()} />
              {list}
            </>
          );
        return rows.then(credentials => (
          <>
            <CredentialsList rows={credentials} me={who} focus={params.get('engine') ?? ''} />
            {list}
          </>
        ));
      }}
    />
  );
}
