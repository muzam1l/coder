import { dynamic } from '@wular/pnext/dynamic';

import { zoneOf } from '@/utils/format';
import { load } from '@/api/load';
import { HEADS } from '@/comps/frame/heads';
import { Page } from '@/comps/frame/page-head';
import { Stream } from '@/comps/frame/stream';
import { TasksSection, loadTasks } from '@/app/dash/tasks/list/tasks-section';
import {
  agentChoices,
  credentialMissing,
  loadComposer,
  savedChoice,
} from '@/app/dash/tasks/composer-data';
import { LoadingComposer } from '@/app/dash/tasks/composer';

// Hydrates with the page, so typing and Enter work at once.
const Composer = dynamic(() => import('@/app/dash/tasks/composer').then(m => m.Composer));

/** One box to start anything, then every task; each streams in on its own. */
export default function TasksPage({ request }: { request?: Request }) {
  if (!request) return null;
  const client = load(request);
  const agent = new URL(request.url).searchParams.get('agent');

  return (
    <Page>
      <Stream
        fallback={<LoadingComposer />}
        load={() =>
          Promise.all([loadComposer(client), credentialMissing(client)]).then(
            ([setup, missing]) => (
              <Composer
                {...setup}
                initial={{
                  ...savedChoice(request.headers.get('cookie') ?? ''),
                  ...(agent ? { agent } : {}),
                }}
                missing={missing}
                tz={zoneOf(request)}
              />
            ),
          )
        }
      />
      <TasksSection
        tasks={loadTasks(request, undefined, agentChoices(client))}
        head={HEADS.tasks}
        missing={credentialMissing(client)}
      />
    </Page>
  );
}
