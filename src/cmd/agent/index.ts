/** `coder agent <sub>`. */
import { commandAgentIntegrations } from './integrations';
import { group } from '../../cli';
import { commandAgentInit } from './init';
import { commandAgentList } from './list';
import { commandAgentPush } from './push';
import { commandAgentRun } from './run';
import { commandAgentShow } from './show';
import { commandAgentUsage } from './usage';

export const commandAgent = group({
  name: 'agent',
  description: 'define and run agents',
  usage:
    'Define and run agents from the CLI, the dashboard, or on GitHub, Slack and other platforms.',
  commands: [
    commandAgentList,
    commandAgentShow,
    commandAgentInit,
    commandAgentPush,
    commandAgentRun,
    commandAgentUsage,
  ],
  namespaces: [commandAgentIntegrations],
  aliases: { ls: 'list' },
});
