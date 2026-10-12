/** `coder connection reconnect <name>`. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { baseOptions } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';
import { askKey, openSignIn, serverOptions } from './add';

export const commandConnectionReconnect = command({
  name: 'connection reconnect',
  help: {
    usage: 'coder connection reconnect <name> [--server [url]] [--json]',
    summary:
      'Give a key connection its new key, read from stdin or a prompt, or sign in to an OAuth connection again in the browser. The credential an API key connection reads gets the new value, so every connection reading it rotates.',
    flags: [SERVER_FLAG],
    examples: [['pbpaste | coder connection reconnect groq', 'the new key from the clipboard']],
  },
  options: { ...baseOptions, ...serverOptions },
  args: 1,
  run: async ({ options, args: [name], cwd }) => {
    const { connection } = await import('../../core/connection');
    return connection.reconnect(name, { ...options, cwd, askKey, onAuthorize: openSignIn });
  },
  print: row => process.stdout.write(`Reconnected ${outStyle.bold(row.id)}.\n`),
});
