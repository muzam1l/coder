import type { To } from '@/comps/nav/to';

/** Page titles and leads, shared by the pages and their loading frames. */
export const HEADS = {
  agents: {
    title: 'Agents',
    lead: 'Each agent listens on the platforms it declares and answers as itself.',
  },
  tasks: {
    title: 'Tasks',
  },
  newAgent: {
    title: 'New agent',
    lead: 'Start from a template or a repository. Everything but the name has a sensible default.',
  },
  usage: {
    title: 'Usage',
    lead: 'Tasks, runner time, and tokens by agent. Pick a range, or open an agent for its breakdown.',
  },
} as const;

/** Back to the section a link came from, named in the link as `from`, or to the page's own list. */
export function backFrom(
  from: string | null,
  list: To & { label: string },
): To & { label: string } {
  const task = from?.match(/^\/dash\/([^\/?]+)\/tasks\/([^\/?]+)$/);
  if (task)
    return {
      href: '/dash/[org]/tasks/[id]',
      params: { org: decodeURIComponent(task[1]!), id: decodeURIComponent(task[2]!) },
      label: 'Task',
    };
  const section = from?.match(/^\/dash\/([^\/?]+)\/(usage|agents|tasks)(?:\?(.*))?$/);
  if (!section) return list;
  const params = { org: decodeURIComponent(section[1]!) };
  const search = new URLSearchParams(section[3] ?? '');
  const label = HEADS[section[2] as keyof typeof HEADS].title;
  if (section[2] === 'usage') return { href: '/dash/[org]/usage', params, search, label };
  if (section[2] === 'agents') return { href: '/dash/[org]/agents', params, search, label };
  return { href: '/dash/[org]/tasks', params, search, label };
}
