/** `coder auth login`: sign in with Wular and pick a workspace. */
import process from 'node:process';

import { CoderError } from '../../core/dispatch';
import { outStyle } from '../../tui/output';
import { canPrompt, openUrl, pick } from '../../tui/prompt';
import { flag, serverOptions } from '../../utils/args';
import { command } from '../../cli';

// Sign-in failures keep their own hint, not the "sign in" one the helper gives a missing session.
export const ownHint = (error: unknown): never => {
  if (error instanceof CoderError && error.code === 'login-failed')
    throw new CoderError('invalid-option', error.message, error.hint ? { hint: error.hint } : {});
  throw error;
};

export const commandLogin = command({
  name: 'login',
  description: 'sign in through the browser',
  usage:
    'Sign in with Wular Auth in your browser. The CLI keeps the tokens in ~/.coder/session.json, and commands that talk to a server then act as you.',
  access: 'write',
  args: {
    ...serverOptions,
    device: flag('show a code to approve on another device; the default without a local browser'),
  },
  globalFlags: { cwd: false },
  cli: {
    env: [['CODER_SERVER', 'the server to use instead of https://coder.wular.ai']],
    examples: [
      'coder auth login  # sign in to the hosted service',
      'coder auth login --server https://agents.example.com  # sign in to a self-hosted server',
    ],
  },
  run: async ({ options, tool }) => {
    const { hasBrowser, sessions } = await import('../../client/auth/sign-in');
    // A tool's stdout is the MCP stream.
    const out = tool ? process.stderr : process.stdout;
    return sessions
      .login({
        server: options.server,
        yes: options.yes,
        device: options.device || !hasBrowser(),
        open: url => {
          out.write(
            `Opening your browser to sign in. If it does not open, visit\n${outStyle.light(url)}\n`,
          );
          openUrl(url);
        },
        onCode: (code, url) =>
          out.write(
            `Confirm this code in your browser: ${outStyle.bold(code)}\n${outStyle.light(url)}\n`,
          ),
        organization: options.workspace,
        ...(canPrompt()
          ? {
              chooseOrganization: async organizations => {
                const [selected] = await pick({
                  title: 'Workspace',
                  hint: 'Commands for this server use this workspace by default.',
                  options: organizations.map(organization => ({
                    value: organization.slug,
                    label: organization.name,
                    hint: organization.slug,
                  })),
                });
                return selected!;
              },
            }
          : {}),
      })
      .catch(ownHint);
  },
  json: login => ({ server: login.server, user: login.user, organization: login.organization }),
  print: login => {
    const s = outStyle;
    process.stdout.write(
      `${s.green('✔')} Signed in to ${s.bold(login.server)} as ${login.user.email}${login.organization ? ` ${s.dim(`· ${login.organization.name}`)}` : ''}\n`,
    );
  },
});
