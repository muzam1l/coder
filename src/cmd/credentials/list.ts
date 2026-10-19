/** `coder credentials list`. */
import process from 'node:process';

import type { CredentialSummary } from '../../server/settings/credentials';
import { outStyle, renderTable } from '../../tui/output';
import { credentialServerOptions } from '../../utils/args';
import { command } from '../../cli';

function printCredentials(rows: CredentialSummary[]): void {
  if (!rows.length) return void process.stdout.write(`${outStyle.dim('No engine credentials.')}\n`);
  process.stdout.write(
    `${renderTable(
      [
        {
          header: 'variable',
          value: (row: CredentialSummary) =>
            row.subscription ? `${row.name} subscription` : row.name,
          paint: c => outStyle.cyan(c),
        },
        {
          header: 'scope',
          value: (row: CredentialSummary) => row.scope,
        },
        {
          header: 'value',
          value: (row: CredentialSummary) => row.masked,
        },
        {
          header: 'account',
          value: (row: CredentialSummary) =>
            [row.account?.email, row.account?.plan].filter(Boolean).join(' '),
        },
      ],
      rows,
      outStyle,
    )}\n`,
  );
}

export const commandCredentialsList = command({
  name: 'list',
  description: 'list your keys and the workspace keys, by variable',
  access: 'read',
  args: credentialServerOptions,
  globalFlags: { cwd: false },
  run: async ({ options }) => {
    const { credentials } = await import('../../core/remote');
    return credentials.list(options);
  },
  print: printCredentials,
});
