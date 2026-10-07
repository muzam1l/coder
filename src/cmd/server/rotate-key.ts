/** `coder server rotate-key`: re-seal the server's stored secrets with the current key. */
import process from 'node:process';

import { flag } from '../../utils/args';
import { command } from '../../cli';

export const commandServerRotateKey = command({
  name: 'server rotate-key',
  globalFlags: { cwd: false },
  help: {
    usage: 'coder server rotate-key [--json]',
    summary:
      'Re-seal stored app, installation, engine, and linked user secrets with the current key.',
    env: [
      ['SERVER_ENCRYPTION_KEY', 'the new key'],
      ['SERVER_ENCRYPTION_KEY_PREVIOUS', 'the old key, still accepted while rotating'],
    ],
  },
  options: { json: flag },
  run: async () => {
    const { rotateKey } = await import('../../server/maintenance');
    return rotateKey();
  },
  json: ({ moved }) => ({ ok: true, moved }),
  print: ({ moved }) =>
    process.stdout.write(`Re-sealed ${moved} secret${moved === 1 ? '' : 's'}.\n`),
});
