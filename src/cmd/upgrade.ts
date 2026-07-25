import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

import * as z from 'zod/mini';

import { flag, parseArgs, str } from '../lib/args.js';
import { getClaudeAvailability } from '../lib/claude-core.js';
import { clearUpdateCache, detectPackageManager } from '../lib/update-check.js';
import { CLI_PATH, readManifestVersion, readVersion, resolveMarketplaceDir } from '../lib/runtime.js';
import {
  agentsSkillDir,
  installAgentsSkill,
  installClaudePlugin,
  readAgentsSkillVersion,
} from '../lib/plugins.js';
import { bad, fail, good, outStyle } from '../lib/ui.js';

export interface UpgradeReport {
  cli?: { pm: string; from: string | null; to: string | null; changed: boolean };
  claudePlugin?: { installed: boolean; note: string; from: string | null; to: string | null };
  agentsSkill?: { installed: boolean; note: string; from: string | null; to: string | null };
}

// Print-free core: update the CLI and/or the host plugin installs, report what
// moved. Performs the real installs (that IS the command); throws on failure.
// onStep is an optional liveness hook the CLI uses for its pre-spawn notice.
export async function upgradeCore(
  opts: {
    cliOnly?: boolean;
    pluginsOnly?: boolean;
    pm?: string;
    codex?: boolean;
    claude?: boolean;
  } = {},
  onStep?: (message: string) => void,
): Promise<UpgradeReport> {
  const doCli = !opts.pluginsOnly;
  const doPlugins = !opts.cliOnly;

  // Read versions off disk BEFORE updating; the package manager replaces the
  // package in place, so re-reading the same paths afterward reports the new
  // versions even though this process still runs the old code.
  const marketplaceDir = resolveMarketplaceDir();
  const claudeManifest = path.join(marketplaceDir, 'plugins/claude/.claude-plugin/plugin.json');
  const before = {
    cli: readVersion(),
    claude: readManifestVersion(claudeManifest),
  };

  const report: UpgradeReport = {};

  // 1. Update the CLI through whichever package manager installed it.
  if (doCli) {
    const detected = detectPackageManager(CLI_PATH);
    const [pmBin, ...pmArgs] =
      opts.pm === 'npm'
        ? ['npm', 'install', '-g', '@wular/coder@latest']
        : opts.pm === 'pnpm'
          ? ['pnpm', 'add', '-g', '@wular/coder@latest']
          : opts.pm === 'yarn'
            ? ['yarn', 'global', 'add', '@wular/coder@latest']
            : opts.pm === 'bun'
              ? ['bun', 'add', '-g', '@wular/coder@latest']
              : detected.command;
    const pm = opts.pm ?? detected.pm;
    onStep?.(`via ${pm}`);
    // Capture output (instead of inherit) so the package manager's noise does
    // not drown the summary; surface it only when the update fails.
    const result = spawnSync(pmBin, pmArgs, { encoding: 'utf8' });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      throw new Error(
        `${pm} not found on PATH. Re-run with --pm <npm|pnpm|yarn|bun>, or update manually: ${pmBin} ${pmArgs.join(' ')}`,
      );
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim();
      throw new Error(
        `CLI update failed (${pm}).${detail ? `\n${detail}` : ''}\nRun manually: ${pmBin} ${pmArgs.join(' ')}`,
      );
    }
    // The on-disk package is now the new version; drop the stale notice cache.
    clearUpdateCache();
    const afterCli = readVersion();
    report.cli = { pm, from: before.cli, to: afterCli, changed: afterCli !== before.cli };
  }

  // 2. Refresh the host installs from the freshly installed package.
  if (doPlugins) {
    const wantClaude = opts.claude || (!opts.codex && getClaudeAvailability().available);
    if (wantClaude) {
      const plugin = installClaudePlugin(marketplaceDir);
      report.claudePlugin = {
        installed: plugin.installed,
        note: plugin.note,
        from: before.claude,
        to: readManifestVersion(claudeManifest),
      };
    }
    // Refresh ~/.agents/skills only when a previous setup-host installed it - a
    // plain file copy, so "was it installed" is just "does the dir exist".
    if (fs.existsSync(agentsSkillDir())) {
      const beforeVer = readAgentsSkillVersion();
      const plugin = installAgentsSkill(marketplaceDir);
      report.agentsSkill = {
        installed: plugin.installed,
        note: plugin.note,
        from: beforeVer,
        to: readAgentsSkillVersion(),
      };
    }
  }

  return report;
}

export async function commandUpgrade(argv: string[]) {
  const { options } = parseArgs(
    argv,
    z.object({ pm: str, 'cli-only': flag, 'plugins-only': flag, codex: flag, claude: flag }),
  );

  const head = outStyle.bold;
  const gray = outStyle.dim;
  // "0.1.7 -> 0.1.8" when the version moved, else "0.1.8 (unchanged)".
  const transition = (before: string | null, after: string | null) =>
    after && before && after !== before
      ? `${before} ${gray('->')} ${head(after)}`
      : `${after ?? before ?? '?'} ${gray('(unchanged)')}`;

  let report: UpgradeReport;
  try {
    report = await upgradeCore(
      {
        cliOnly: options['cli-only'],
        pluginsOnly: options['plugins-only'],
        pm: options.pm,
        codex: options.codex,
        claude: options.claude,
      },
      pm => process.stdout.write(`${head('Updating coder CLI')} ${gray(`${pm}...`)}\n`),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (report.cli) {
    process.stdout.write(
      report.cli.changed
        ? `${good(`coder CLI  ${transition(report.cli.from, report.cli.to)}`)}\n`
        : `${good(`coder CLI  ${report.cli.from} ${gray('(already latest)')}`)}\n`,
    );
  }
  if (report.claudePlugin) {
    const p = report.claudePlugin;
    process.stdout.write(
      `${
        p.installed
          ? good(`claude plugin ${transition(p.from, p.to)} ${gray(`- ${p.note}`)}`)
          : bad(`claude plugin ${p.note}`)
      }\n`,
    );
  }
  if (report.agentsSkill) {
    const p = report.agentsSkill;
    process.stdout.write(
      `${
        p.installed
          ? good(`agents skill  ${transition(p.from, p.to)} ${gray(`- ${p.note}`)}`)
          : bad(`agents skill  ${p.note}`)
      }\n`,
    );
  }
}
