/** `coder agent integrations <sub>`: the integration catalog. */
import { group } from '../../../cli';
import { commandIntegrationsList } from './list';
import { commandIntegrationsShow } from './show';

export const commandAgentIntegrations = group({
  name: 'integrations',
  description: 'the integration catalog: events and tool presets',
  usage: 'The platforms an agent can listen to and act on: their events and tool presets.',
  commands: [commandIntegrationsList, commandIntegrationsShow],
  aliases: { ls: 'list' },
});
