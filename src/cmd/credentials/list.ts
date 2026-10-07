/** `coder credentials list`. */
import process from 'node:process';

import type { CredentialSummary } from '../../server/settings/credentials';
import { outStyle, renderTable } from '../../tui/output';
import { flag, serverOnly } from '../../utils/args';
import { command, CREDENTIAL_SERVER_FLAG } from '../../cli';

function printCredentials(rows: CredentialSummary[]): void {
  if (!rows.length) return void process.stdout.write(`${outStyle.dim('No engine credentials.')}\n`);
  process.stdout.write(
    `${renderTable(
      [
        {
          header: 'label',
          value: (row: CredentialSummary) => row.label,
          paint: c => outStyle.cyan(c),
        },
        {
          header: 'engine',
          value: (row: CredentialSummary) => row.engine,
        },
        {
          header: 'scope',
          value: (row: CredentialSummary) => row.scope,
        },
        {
          header: 'default',
          value: (row: CredentialSummary) => (row.isDefault ? '✔' : ''),
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
  name: 'credentials list',
  globalFlags: { cwd: false },
  help: {
    usage: 'coder credentials list [--server [url]] [--json]',
    flags: [CREDENTIAL_SERVER_FLAG],
  },
  options: { json: flag, server: serverOnly, yes: flag },
  run: async ({ options }) => {
    const { connect } = await import('../../core/remote');
    return connect(options).credentials.list();
  },
  print: printCredentials,
});
