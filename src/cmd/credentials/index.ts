/** `coder credentials <list|add|login|remove|default>`. */
import { group } from '../../cli';

export const commandCredentials = group(
  'credentials',
  {
    list: async () => (await import('./list')).commandCredentialsList,
    add: async () => (await import('./add')).commandCredentialsAdd,
    login: async () => (await import('./login')).commandCredentialsLogin,
    remove: async () => (await import('./remove')).commandCredentialsRemove,
    default: async () => (await import('./default')).commandCredentialsDefault,
  },
  undefined,
  {
    help: {
      usage: 'coder credentials [list|add|login|remove|default] ...',
      summary:
        "Manage engine credentials. Your personal ones are yours alone; workspace ones serve every member, and only owners and admins change them. A task runs on its requester's default for the engine, else the workspace's.",
    },
  },
);
