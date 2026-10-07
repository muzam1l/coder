/** `coder auth status`: the saved sessions, one per server. */
import process from 'node:process';

import { formatHints, outStyle, renderTable } from '../../tui/output';
import { flag } from '../../utils/args';
import { command } from '../../cli';

export const commandStatus = command({
  name: 'auth status',
  globalFlags: { cwd: false },
  help: {
    usage: 'coder auth status [--json]',
    summary: 'List saved sessions with their server, user, and workspace.',
    env: [['CODER_SERVER', 'the server to use instead of https://coder.wular.ai']],
  },
  options: { json: flag },
  run: async () => {
    const { sessions } = await import('../../client/auth/sign-in');
    return sessions.status();
  },
  print: status => {
    const s = outStyle;
    const logins = Object.entries(status);
    if (!logins.length)
      return void process.stdout.write(
        `${s.dim('Not signed in')}\n\n${formatHints(['Sign in: coder auth login'], s)}\n`,
      );
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
