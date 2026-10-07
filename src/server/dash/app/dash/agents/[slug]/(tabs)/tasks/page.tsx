import { TasksSection, loadTasks } from '@/app/dash/tasks/list/tasks-section';

export default async function AgentTasksPage({
  request,
  params,
}: {
  request?: Request;
  params: Promise<Record<string, string | string[]>>;
}) {
  if (!request) return null;
  const { slug: raw } = await params;
  const slug = Array.isArray(raw) ? raw[0]! : raw!;
  return <TasksSection tasks={loadTasks(request, slug)} agent={slug} />;
}
