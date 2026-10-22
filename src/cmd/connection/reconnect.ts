/** `coder connection reconnect <name>`. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import * as z from 'zod/mini';

import { serverOptions } from '../../utils/args';
import { command } from '../../cli';
import { askKey, noKey, openSignIn } from './add';

export const commandConnectionReconnect = command({
  name: 'reconnect',
  description: 'give a connection a new key, or sign in again',
  usage:
    'Give a key connection its new key, read from stdin or a prompt, or sign in to an OAuth connection again in the browser. The credential an API key connection reads gets the new value, so every connection reading it rotates.',
  access: 'write',
  approvalPolicy: {
    handoff: {
      page: '/settings/connections',
      label: 'Reconnect the connection',
      action: 'reconnect',
      args: ['name'],
    },
  },
  args: { name: z.string().check(z.describe('the connection')), ...serverOptions },
  cli: {
    positional: ['name'],
    examples: ['pbpaste | coder connection reconnect groq  # the new key from the clipboard'],
  },
  run: async ({ options, args: [name], cwd, tool }) => {
    const { connection } = await import('../../core/connection');
    return connection.reconnect(name, {
      ...options,
      cwd,
      askKey: tool ? noKey : askKey,
      onAuthorize: tool ? undefined : openSignIn,
    });
  },
  print: row => process.stdout.write(`Reconnected ${outStyle.bold(row.id)}.\n`),
});
