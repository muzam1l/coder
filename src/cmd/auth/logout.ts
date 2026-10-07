/** `coder auth logout`: forget a server's saved session. */
import process from 'node:process';

import { flag, optStr } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';
import { ownHint } from './login';

export const commandLogout = command({
  name: 'auth logout',
  globalFlags: { cwd: false },
  help: {
    usage: 'coder auth logout [--server [url]] [--json]',
    summary: 'Revoke the saved session for that server at Wular Auth and forget its tokens.',
    flags: [SERVER_FLAG],
  },
  options: { json: flag, server: optStr, yes: flag },
  run: async ({ options }) => {
    const { sessions } = await import('../../client/auth/sign-in');
    return sessions.logout(options).catch(ownHint);
  },
  print: result => process.stdout.write(`Signed out of ${result.server}.\n`),
});
