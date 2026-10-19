/** `coder auth status`: the saved sessions, one per server. */
import process from 'node:process';

import { outStyle, renderTable } from '../../tui/output';
import { command, nextSteps } from '../../cli';

export const commandStatus = command({
  name: 'status',
  description: 'show where you are signed in',
  usage: 'List saved sessions with their server, user, and workspace.',
  access: 'read',
  globalFlags: { cwd: false },
  cli: { env: [['CODER_SERVER', 'the server to use instead of https://coder.wular.ai']] },
  run: async () => {
    const { sessions } = await import('../../client/auth/sign-in');
    return sessions.status();
  },
  next: ({ result }) =>
    Object.keys(result).length ? [] : nextSteps(['Sign in: coder auth login']),
  print: status => {
    const s = outStyle;
    const logins = Object.entries(status);
    if (!logins.length) return void process.stdout.write(`${s.dim('Not signed in')}\n`);
    process.stdout.write(
      `${renderTable(
        [
          { header: 'server', value: ([server]) => server, paint: c => s.cyan(c) },
          { header: 'user', value: ([, login]) => login.user.email },
          {
            header: 'workspace',
            value: ([, login]) =>
              login.organization ? `${login.organization.name} (${login.organization.slug})` : '-',
          },
        ],
        logins,
        s,
      )}\n`,
    );
  },
});
