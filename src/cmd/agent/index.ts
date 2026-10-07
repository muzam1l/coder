/** `coder agent <sub>`. */
import { group } from '../../cli';

const AGENT_MENU: { usage: string; blurb: string }[] = [
  { usage: 'list', blurb: 'list local or server-owned agents' },
  {
    usage: 'show <id>',
    blurb: 'one agent in full: settings, integrations, triggers, tools',
  },
  { usage: 'init [id]', blurb: 'scaffold an agent folder in .coder/agents' },
  { usage: 'push [id]', blurb: 'upload workspace agents to a Coder server' },
  {
    usage: 'integrations <list|show>',
    blurb: 'the integration catalog: coder agent integrations --help',
  },
  {
    usage: 'run <agent> <event.json>',
    blurb: 'run a recorded event through an agent, offline or on a server',
  },
  { usage: 'usage', blurb: 'aggregate usage by agent, installation, or engine' },
];

export const commandAgent = group(
  'agent',
  {
    tools: async () => (await import('./tools')).commandTools,
    list: async () => (await import('./list')).commandAgentList,
    ls: async () => (await import('./list')).commandAgentList,
    show: async () => (await import('./show')).commandAgentShow,
    run: async () => (await import('./run')).commandAgentRun,
    init: async () => (await import('./init')).commandAgentInit,
    push: async () => (await import('./push')).commandAgentPush,
    usage: async () => (await import('./usage')).commandAgentUsage,
    integrations: async () => (await import('./integrations')).commandAgentIntegrations,
  },
  {
    menu: AGENT_MENU,
    description: [
      'Define and run agents from the CLI, the dashboard, or on GitHub, Slack and other platforms.',
    ],
  },
  { aliases: { ls: 'list' }, nested: ['integrations'] },
);
