/** `coder credentials <list|add|login|remove>`. */
import { group } from '../../cli';

export const commandCredentials = group(
  'credentials',
  {
    list: async () => (await import('./list')).commandCredentialsList,
    add: async () => (await import('./add')).commandCredentialsAdd,
    login: async () => (await import('./login')).commandCredentialsLogin,
    remove: async () => (await import('./remove')).commandCredentialsRemove,
  },
  undefined,
  {
    help: {
      usage: 'coder credentials [list|add|login|remove] ...',
      summary:
        "Manage subscriptions and API keys, one per variable in each scope. Your personal ones are yours alone; workspace ones serve every member, and only owners and admins change them. A task runs on its requester's own, else the workspace's.",
    },
  },
);
