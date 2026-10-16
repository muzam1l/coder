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
