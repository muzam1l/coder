/** `coder credentials <list|add|login|remove>`. */
import { group } from '../../cli';
import { commandCredentialsAdd } from './add';
import { commandCredentialsList } from './list';
import { commandCredentialsLogin } from './login';
import { commandCredentialsRemove } from './remove';

export const commandCredentials = group({
  name: 'credentials',
  description: 'engine credentials: subscriptions and API keys',
  usage:
    "Manage subscriptions and API keys, one per variable in each scope. Your personal ones are yours alone; workspace ones serve every member, and only owners and admins change them. A task runs on its requester's own, else the workspace's.",
  commands: [
    commandCredentialsList,
    commandCredentialsAdd,
    commandCredentialsLogin,
    commandCredentialsRemove,
  ],
});
