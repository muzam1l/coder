/** `coder connection <add|list|rm|reconnect|approve>`: services tasks may use, on this machine or a Coder server. */
import { group } from '../../cli';
import { commandConnectionAdd } from './add';
import { commandConnectionApprove } from './approve';
import { commandConnectionList } from './list';
import { commandConnectionReconnect } from './reconnect';
import { commandConnectionRemove } from './remove';

export const commandConnection = group({
  name: 'connection',
  description: 'platform accounts and MCP servers tasks use',
  usage: [
    'Connections give tasks access to a service through a platform account or an MCP server.',
    'They live in ~/.coder, or on the Coder server with --server, and tasks may use them unless an agent or `coder task run --connections` narrows the set.',
  ].join(' '),
  commands: [
    commandConnectionAdd,
    commandConnectionList,
    commandConnectionRemove,
    commandConnectionReconnect,
    commandConnectionApprove,
  ],
  aliases: { ls: 'list', remove: 'rm' },
});
