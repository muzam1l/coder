/** `coder server app create <integration>`: open the page that creates the built-in agent's public app. */
import process from 'node:process';

import { CoderError } from '../../../core/dispatch';
import { openUrl } from '../../../tui/prompt';
import { flag, str } from '../../../utils/args';
import { command } from '../../../cli';

export const commandServerAppCreate = command({
  name: 'server app create',
  globalFlags: { cwd: false },
  help: {
    usage: 'coder server app create <integration> [--org <org>] [--name <name>] [--json]',
    summary:
      "Open the page that creates the built-in agent's public app on a platform, once per server. Every workspace then connects it from its dashboard with one click. Run it where the server's environment is set.",
    flags: [
      ['--org <org>', 'create it under this organization instead of your own account'],
      ['--name <name>', "the app's name and handle (default Coder)"],
    ],
    env: [
      ['DATABASE_URL', "the server's Postgres"],
      ['PUBLIC_URL', "the server's address, which goes into the app"],
    ],
    examples: [
      ['coder server app create github --name wular-coder', 'the hosted GitHub App'],
      ['coder server app create slack', 'the Slack app'],
    ],
  },
  options: { org: str, name: str, json: flag },
  args: 1,
  async run({ options, args: [integration] }) {
    const { serverAppLink } = await import('../../../server/agents/apps');

    if (!integration)
      throw new CoderError('invalid-option', 'Missing integration, such as github or slack.');
    return serverAppLink(integration, { owner: options.org, name: options.name });
  },
  json: ({ url }) => ({ ok: true, url }),
  print({ url }) {
    process.stdout.write(`Open this page to create the app (valid 10 minutes):\n${url}\n`);
    openUrl(url);
  },
});
