/** `coder server <serve|rotate-key|workflow|app>`: a group; the work is in the subcommands. */
import { commandServerApp } from './app';
import { group } from '../../cli';
import { commandServerRotateKey } from './rotate-key';
import { commandServerServe } from './serve';
import { commandServerWorkflow } from './workflow';

export const commandServer = group({
  name: 'server',
  description: 'self-host Coder: the server, its dashboard and sign-in',
  usage:
    'Self-host Coder: the server your agents and platform apps talk to, with a dashboard and sign-in. We run one as the hosted service; you can run your own.',
  namespaces: [commandServerApp],
  commands: [commandServerServe, commandServerRotateKey, commandServerWorkflow],
});
