/** `coder runner serve`: run a server's tasks on this machine, reachable through any tunnel. */
import process from 'node:process';

import * as z from 'zod/mini';

import { formatHints, outStyle } from '../../tui/output';
import { baseOptions, flag, serverOnly, str } from '../../utils/args';
import { command, CREDENTIAL_SERVER_FLAG } from '../../cli';

export const commandRunnerServe = command({
  name: 'runner serve',
  help: {
    usage:
      'coder runner serve --url <public url> [--token <token>] [--runner-url <url>] [--port <n>] [--name <name>] [--workspace] [--server [url]] [--json]',
    summary:
      "Run tasks on this machine with its own claude and codex logins. Expose the port with any tunnel (cloudflared, ngrok, Tailscale Funnel or a public VS Code port) and pass the tunnel's URL; each start registers the current URL, so a changing tunnel URL is fine. Choose a default with coder runner default. Tasks use their named runner, the agent setting, your default, the workspace default, then the server default.",
    flags: [
      ['--url <public url>', 'the HTTPS address the server reaches this runner at'],
      ['--token <token>', 'one-use pairing token, --url is the Coder server'],
      ['--runner-url <url>', 'public tunnel address when pairing, or CODER_RUNNER_URL'],
      ['--port <n>', 'local port the tunnel forwards to (default 4100)'],
      ['--name <name>', "shown in the dashboard (default: this machine's hostname)"],
      ['--workspace', "run every member's tasks, not only yours (owners and admins)"],
      CREDENTIAL_SERVER_FLAG,
    ],
    examples: [
      ['cloudflared tunnel --url http://localhost:4100', 'expose the port in one terminal'],
      ['coder runner serve --url https://abc.trycloudflare.com', 'then serve through it'],
    ],
  },
  options: {
    ...baseOptions,
    port: z.optional(z.coerce.number().check(z.int(), z.positive())),
    url: str,
    name: str,
    token: str,
    'runner-url': str,
    workspace: flag,
    server: serverOnly,
    yes: flag,
  },
  async run({ options }) {
    const { serveRunner } = await import('../../runner/serve');

    const runner = await serveRunner({ ...options, runnerUrl: options['runner-url'] });
    const shutdown = () => void runner.close().finally(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return runner;
  },
  json: ({ server, close, ...runner }) => ({ ok: true, ...runner }),
  print: result =>
    process.stdout.write(
      `Runner ${outStyle.bold(result.name)} serves ${result.server} at ${outStyle.cyan(result.config.url ?? '')} (${result.scope}), listening on localhost:${result.port}.\n${formatHints(["Tasks run here with this machine's own claude and codex logins", 'Stop with Ctrl-C; the server marks the runner offline'], outStyle, outStyle.cyan)}\n`,
    ),
});
