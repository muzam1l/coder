import { dynamic } from '@wular/pnext/dynamic';

import { load } from '@/api/load';
import { Settle } from '@/comps/frame/stream';
import { localServer } from '@/api/types';

// Hydrates as soon as the page does, so its sign-in buttons are live at once.
const CredentialsList = dynamic(() => import('./credentials-list').then(m => m.CredentialsList));
const EngineLogins = dynamic(() => import('./credentials-list').then(m => m.EngineLogins));

/** Same-origin dashboard path to go back to after signing in. */
const backPath = (value: string | null) => (value && /^\/(?!\/)/.test(value) ? value : undefined);

/** The credentials settings tab. */
export function Credentials({ request }: { request: Request }) {
  const params = new URL(request.url).searchParams;
  const me = load(request).me();
  const rows = load(request).credentials.list();

  return (
    <Settle
      load={async () => {
        const who = await me;
        if (localServer(who)) return <EngineLogins status={await load(request).engines.status()} />;
        return rows.then(list => (
          <CredentialsList
            rows={list}
            me={who}
            focus={params.get('engine') ?? ''}
            back={backPath(params.get('return'))}
          />
        ));
      }}
    />
  );
}
