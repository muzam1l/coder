import { load } from '@/api/load';
import { HEADS } from '@/comps/frame/heads';
import { Page } from '@/comps/frame/page-head';
import { TasksSection, loadTasks } from '@/app/dash/tasks/list/tasks-section';
import { credentialMissing } from '@/app/dash/tasks/composer-data';

/** Every task, with New task in the head. */
export default function TasksPage({ request }: { request?: Request }) {
  if (!request) return null;
  const client = load(request);

  return (
    <Page>
      <TasksSection
        tasks={loadTasks(request)}
        head={HEADS.tasks}
        missing={credentialMissing(client)}
      />
    </Page>
  );
}
