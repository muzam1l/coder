/** `coder server migrate`: apply the server database's pending migrations. */
import process from 'node:process';

import { flag } from '../../utils/args';
import { command } from '../../cli';

export const commandServerMigrate = command({
  name: 'server migrate',
  globalFlags: { cwd: false },
  help: {
    usage: 'coder server migrate [--json]',
    summary:
      'Create or update the tables in the Postgres at DATABASE_URL. Run it before the first start and after every upgrade; the server only warns when it is behind.',
    env: [['DATABASE_URL', 'the Postgres to migrate']],
    examples: [['DATABASE_URL=postgres://... coder server migrate', 'bring a database up to date']],
  },
  options: { json: flag },
  run: async () => {
    const { migrate } = await import('../../server/maintenance');
    return migrate();
  },
  json: ({ applied }) => ({ ok: true, applied }),
  print: ({ applied }) =>
    process.stdout.write(
      applied
        ? `Applied ${applied} migration${applied === 1 ? '' : 's'}.\n`
        : 'Database is up to date.\n',
    ),
});
