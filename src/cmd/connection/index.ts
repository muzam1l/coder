/** `coder connection <add|list|rm|reconnect|approve>`: services tasks may use, on this machine or a Coder server. */
import { group } from '../../cli';
import { commandConnectionAdd } from './add';
import { commandConnectionApprove } from './approve';
import { commandConnectionList } from './list';
import { commandConnectionReconnect } from './reconnect';
import { commandConnectionRemove } from './remove';

export const commandConnection = group({
  name: 'connection',
  description: 'platform accounts, API keys and MCP servers tasks use',
  usage:
    'Connections give tasks access to a service without a handle: a platform account, an API key tasks read from the environment, or an MCP server. They live in ~/.coder, or on your Coder server with --server, and every task of yours may use them unless its agent or `coder task run --connections` narrows the set.',
  commands: [
    commandConnectionAdd,
    commandConnectionList,
    commandConnectionRemove,
    commandConnectionReconnect,
    commandConnectionApprove,
  ],
  aliases: { ls: 'list', remove: 'rm' },
});
