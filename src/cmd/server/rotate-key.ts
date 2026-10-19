/** `coder server rotate-key`: re-seal the server's stored secrets with the current key. */
import process from 'node:process';

import { command } from '../../cli';

export const commandServerRotateKey = command({
  name: 'rotate-key',
  description: 're-seal secrets with SERVER_ENCRYPTION_KEY',
  usage: 'Re-seal stored app, installation, engine, and linked user secrets with the current key.',
  access: 'write',
  globalFlags: { cwd: false },
  cli: {
    env: [
      ['SERVER_ENCRYPTION_KEY', 'the new key'],
      ['SERVER_ENCRYPTION_KEY_PREVIOUS', 'the old key, still accepted while rotating'],
    ],
  },
  run: async () => {
    const { rotateKey } = await import('../../server/maintenance');
    return rotateKey();
  },
  json: ({ moved }) => ({ ok: true, moved }),
  print: ({ moved }) =>
    process.stdout.write(`Re-sealed ${moved} secret${moved === 1 ? '' : 's'}.\n`),
});
