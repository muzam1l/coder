/** `coder auth logout`: forget a server's saved session. */
import process from 'node:process';

import { flag, optStr } from '../../utils/args';
import { command } from '../../cli';
import { ownHint } from './login';

export const commandLogout = command({
  name: 'logout',
  description: 'sign out and forget the saved session',
  usage: 'Revoke the saved session for that server at Wular Auth and forget its tokens.',
  access: 'write',
  approvalPolicy: 'deny',
  args: {
    server: optStr('sign out of this Coder server (default: the hosted one)', '[url]'),
    yes: flag('connect to a server used for the first time without asking'),
  },
  globalFlags: { cwd: false },
  run: async ({ options }) => {
    const { sessions } = await import('../../client/auth/sign-in');
    return sessions.logout(options).catch(ownHint);
  },
  print: result => process.stdout.write(`Signed out of ${result.server}.\n`),
});
