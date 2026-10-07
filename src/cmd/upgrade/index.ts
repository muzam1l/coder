/** `coder upgrade`: update the CLI and refresh the host plugins. */
import process from 'node:process';

import { upgradeCore, type UpgradeReport } from '../../core/hosts';
import { bad, good, outStyle } from '../../tui/output';
import { flag, str } from '../../utils/args';
import { command } from '../../cli';

const upgrade = command({
  name: 'upgrade',
  globalFlags: { json: false, cwd: false },
  help: {
    usage: 'coder upgrade [--cli-only] [--plugins-only] [--codex] [--claude] [--pm <mgr>]',
    summary:
      'Update the coder CLI through whichever package manager installed it, then refresh\nthe host plugins to match. Alias: update.',
    flags: [
      ['--cli-only', 'update just the CLI'],
      ['--plugins-only', 'refresh just the host plugins'],
      ['--codex', 'limit the refresh to the Agent Skills copy (Codex, Pi, ...)'],
      ['--claude', 'limit the refresh to the Claude Code plugin'],
      ['--pm <npm|pnpm|yarn|bun>', 'force a package manager instead of auto-detecting'],
    ],
  },
  options: { pm: str, 'cli-only': flag, 'plugins-only': flag, codex: flag, claude: flag },
  run: ({ options }) =>
    upgradeCore(
      { ...options, cliOnly: options['cli-only'], pluginsOnly: options['plugins-only'] },
      printUpgradeStep,
    ),
  print: printUpgrade,
});

// Printed before the package manager runs.
function printUpgradeStep(pm: string): void {
  process.stdout.write(`${outStyle.bold('Updating coder CLI')} ${outStyle.dim(`${pm}...`)}\n`);
}

function printUpgrade(report: UpgradeReport): void {
  const head = outStyle.bold;
  const gray = outStyle.dim;
  // "0.1.7 -> 0.1.8" when the version moved, else "0.1.8 (unchanged)".
  const transition = (before: string | null, after: string | null) =>
    after && before && after !== before
      ? `${before} ${gray('->')} ${head(after)}`
      : `${after ?? before ?? '?'} ${gray('(unchanged)')}`;
  const plugin = (label: string, p: NonNullable<UpgradeReport['claudePlugin']>) =>
    `${p.installed ? good(`${label} ${transition(p.from, p.to)} ${gray(`- ${p.note}`)}`) : bad(`${label} ${p.note}`)}\n`;

  if (report.cli) {
    process.stdout.write(
      report.cli.changed
        ? `${good(`coder CLI  ${transition(report.cli.from, report.cli.to)}`)}\n`
        : `${good(`coder CLI  ${report.cli.from} ${gray('(already latest)')}`)}\n`,
    );
  }
  if (report.claudePlugin) process.stdout.write(plugin('claude plugin', report.claudePlugin));
  if (report.agentsSkill) process.stdout.write(plugin('agents skill ', report.agentsSkill));
}

const refresh = async () => (await import('./refresh')).commandRefreshUpdate;

export const commandUpgrade = Object.assign(
  async (argv: string[]) => {
    if (argv[0] === 'refresh') return (await refresh())(argv.slice(1));
    return upgrade(argv);
  },
  upgrade,
  { subcommands: { refresh } },
);
