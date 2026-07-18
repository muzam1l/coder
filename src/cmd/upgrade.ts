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
import { fail } from '../lib/ui.js';

export async function commandUpgrade(argv: string[]) {
  const { options } = parseArgs(
    argv,
    z.object({ pm: str, 'cli-only': flag, 'plugins-only': flag, codex: flag, claude: flag }),
  );
  const doCli = !options['plugins-only'];
  const doPlugins = !options['cli-only'];

  const tty = process.stdout.isTTY && !process.env.NO_COLOR;
  const paint = (code: string, text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
  const head = (text: string) => paint('1', text);
  const gray = (text: string) => paint('38;5;245', text);
  const good = (text: string) => `  ${paint('32', '✔')} ${text}`;
  const bad = (text: string) => `  ${paint('31', '✘')} ${text}`;
  // "0.1.7 -> 0.1.8" when the version moved, else "0.1.8 (unchanged)".
  const transition = (before: string | null, after: string | null) =>
    after && before && after !== before
      ? `${before} ${gray('->')} ${head(after)}`
      : `${after ?? before ?? '?'} ${gray('(unchanged)')}`;

  // Read versions off disk BEFORE updating; npm/pnpm/etc. replace the package
  // (CLI bundle + bundled plugin manifests) in place, so re-reading the same
  // paths afterward reports the new versions even though this process is still
  // running the old code.
  const marketplaceDir = resolveMarketplaceDir();
  const claudeManifest = path.join(marketplaceDir, 'plugins/claude/.claude-plugin/plugin.json');
  const before = {
    cli: readVersion(),
    claude: readManifestVersion(claudeManifest),
  };

  // 1. Update the CLI through whichever package manager installed it, so the
  //    command works regardless of install source (npm/pnpm/yarn/bun).
  if (doCli) {
    const detected = detectPackageManager(CLI_PATH);
    const [pmBin, ...pmArgs] =
      options.pm === 'npm'
        ? ['npm', 'install', '-g', '@wular/coder@latest']
        : options.pm === 'pnpm'
          ? ['pnpm', 'add', '-g', '@wular/coder@latest']
          : options.pm === 'yarn'
            ? ['yarn', 'global', 'add', '@wular/coder@latest']
            : options.pm === 'bun'
              ? ['bun', 'add', '-g', '@wular/coder@latest']
              : detected.command;
    const pm = options.pm ?? detected.pm;
    process.stdout.write(`${head('Updating coder CLI')} ${gray(`via ${pm}...`)}\n`);
    // Capture output (instead of inherit) so the package manager's own noise
    // ("changed 2 packages", funding notices) does not drown the summary; show
    // it only if the update fails.
    const result = spawnSync(pmBin, pmArgs, { encoding: 'utf8' });
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      fail(
        `${pm} not found on PATH. Re-run with --pm <npm|pnpm|yarn|bun>, or update manually: ${pmBin} ${pmArgs.join(' ')}`,
      );
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim();
      fail(
        `CLI update failed (${pm}).${detail ? `\n${detail}` : ''}\nRun manually: ${pmBin} ${pmArgs.join(' ')}`,
      );
    }
    // The on-disk package (and its bundled plugins) is now the new version.
    // Drop the stale notice cache; the next run re-checks fresh.
    clearUpdateCache();
    const afterCli = readVersion();
    process.stdout.write(
      afterCli !== before.cli
        ? `${good(`coder CLI  ${transition(before.cli, afterCli)}`)}\n`
        : `${good(`coder CLI  ${before.cli} ${gray('(already latest)')}`)}\n`,
    );
  }

  // 2. Refresh the host installs from the freshly installed package. Claude
  //    Code gets its marketplace plugin re-added (it caches the installed
  //    copy); every Agent Skills host (codex included) gets the refreshed
  //    ~/.agents/skills copy. --codex/--claude narrow it.
  if (doPlugins) {
    const wantClaude = options.claude || (!options.codex && getClaudeAvailability().available);

    if (wantClaude) {
      const plugin = installClaudePlugin(marketplaceDir);
      const afterVer = readManifestVersion(claudeManifest);
      process.stdout.write(
        `${
          plugin.installed
            ? good(`claude plugin ${transition(before.claude, afterVer)} ${gray(`- ${plugin.note}`)}`)
            : bad(`claude plugin ${plugin.note}`)
        }\n`,
      );
    }

    // Refresh the ~/.agents/skills copy (codex, pi, opencode, other Agent
    // Skills hosts) only when a previous setup-host installed it - it is a
    // plain file copy, so "was it installed" is just "does the dir exist".
    if (fs.existsSync(agentsSkillDir())) {
      const beforeVer = readAgentsSkillVersion();
      const plugin = installAgentsSkill(marketplaceDir);
      const afterVer = readAgentsSkillVersion();
      process.stdout.write(
        `${
          plugin.installed
            ? good(`agents skill  ${transition(beforeVer, afterVer)} ${gray(`- ${plugin.note}`)}`)
            : bad(`agents skill  ${plugin.note}`)
        }\n`,
      );
    }
  }
}
