/** `coder credentials login <claude|codex>`: subscription sign-in through the server's runner. */
import process from 'node:process';
import readline from 'node:readline/promises';

import {type LoginView} from '../../server/settings/logins';
import { errStyle, formatHints, outStyle } from '../../tui/output';
import { flag, serverOnly } from '../../utils/args';
import { command, CREDENTIAL_SERVER_FLAG } from '../../cli';

function printLoginLink(login: LoginView): void {
  if (login.url) process.stderr.write(`Open ${outStyle.cyan(login.url)}\n`);
  if (login.code) process.stderr.write(`Enter the code ${outStyle.bold(login.code)}\n`);
}

async function askLoginCode(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const code = (await rl.question('Paste the code from the sign-in page ')).trim();
  rl.close();
  return code;
}

function printLogin(login: LoginView): void {
  if (login.state === 'failed')
    return void process.stderr.write(
      `${errStyle.red(login.error ?? 'Sign-in failed.')}\n\n${formatHints(['Try again'], errStyle)}\n`,
    );
  process.stdout.write(
    `Signed in. Personal credential ${outStyle.bold(login.label ?? login.engine)} is your ${login.engine} default.\n`,
  );
}

export const commandCredentialsLogin = command({
  name: 'credentials login',
  globalFlags: { cwd: false },
  help: {
    usage: 'coder credentials login <claude|codex> [--server [url]] [--json]',
    summary:
      "Runs the official claude or codex sign-in on the server's runner, prints the sign-in link or device code, and waits. Claude asks you to paste the code the sign-in page shows. The result is your personal default for that engine. Needs CLAUDE_SUBSCRIPTIONS=1 or CODEX_SUBSCRIPTIONS=1 on the server.",
    flags: [CREDENTIAL_SERVER_FLAG],
  },
  options: { json: flag, server: serverOnly, yes: flag },
  args: 1,
  run: async ({ options, args: [engine] }) => {
    const { loginCredential } = await import('../../core/remote');
    return loginCredential(engine, {
      ...options,
      onStart: cancel =>
        process.once('SIGINT', () => void cancel().finally(() => process.exit(130))),
      onOpen: printLoginLink,
      code: askLoginCode,
    });
  },
  print: printLogin,
  exit: (login, { options }) => (!options.json && login.state === 'failed' ? 1 : undefined),
});
