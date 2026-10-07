/** `coder agent integrations <sub>`: the integration catalog. */
import { group } from '../../../cli';

const INTEGRATIONS_MENU: { usage: string; blurb: string }[] = [
  { usage: 'list', blurb: 'list integrations with their events and tools' },
  { usage: 'show <id>', blurb: 'events and tools of one integration' },
];

export const commandAgentIntegrations = group(
  'agent integrations',
  {
    list: async () => (await import('./list')).commandIntegrationsList,
    ls: async () => (await import('./list')).commandIntegrationsList,
    show: async () => (await import('./show')).commandIntegrationsShow,
  },
  {
    menu: INTEGRATIONS_MENU,
    description: [
      'The platforms an agent can listen to and act on: their events and tool presets.',
    ],
  },
  { aliases: { ls: 'list' } },
);
