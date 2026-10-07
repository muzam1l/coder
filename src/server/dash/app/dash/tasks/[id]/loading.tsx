import { Back, Page } from '@/comps/frame/page-head';
import { Loading } from '@/comps/ui/card';
import { LoadingTabs } from '@/comps/ui/tabs';
import { BLANK } from '@/comps/frame/loading-card';

export default function TaskLoading() {
  return (
    <Page>
      <LoadingTask />
    </Page>
  );
}

/** A task's head and tabs, blank like `LoadingHero`, then one loader for the rest. */
function LoadingTask() {
  return (
    <>
      <header class="head">
        <div>
          <Back href="/dash/tasks" params={{}} label="Tasks" />
          <div class="title-row">
            <h1>{BLANK}</h1>
          </div>
          <p class="lead">{BLANK}</p>
        </div>
      </header>
      <LoadingTabs labels={['Conversation', 'Activity', 'Diff']} />
      <Loading label="Loading task" />
    </>
  );
}
