/** Host wiring: plugin and skill installation plus codex install/version gating (`coder setup`, `coder upgrade`). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { CoderError } from './dispatch';
import { compareVersions, clearUpdateCache, detectPackageManager } from './update-check';
import { readVersion, resolveMarketplaceDir, CLI_PATH, readManifestVersion } from './runtime';
import type { Availability, Engine, CoderConfig } from './types';
import { getCodexAuthStatus, getCodexAvailability } from './engines/codex';
import { getClaudeAuthStatus, getClaudeAvailability } from './engines/claude';
import { DEFAULT_CONFIG, loadConfig, resolveUserConfigFile, writeUserConfig } from './config';

/** Result of a plugin install/refresh attempt. */
export interface PluginResult {
  marketplace: string;
  installed: boolean;
  note: string;
}

/** Outcome of the codex auto-update check; null when nothing to do. */
export type CodexUpdateResult =
  { updated: true; from: string } | { updated: false; from: string; note: string } | null;

// Install through the claude CLI's plugin commands, exactly what a user would
// type by hand. Re-adding refreshes both the marketplace snapshot and the
// cached plugin copy (claude caches installs per version).
export function installClaudePlugin(marketplaceDir: string): PluginResult {
  spawnSync('claude', ['plugin', 'marketplace', 'remove', 'coder-plugins'], { encoding: 'utf8' });
  const addMarketplace = spawnSync('claude', ['plugin', 'marketplace', 'add', marketplaceDir], {
    encoding: 'utf8',
  });
  const install = spawnSync('claude', ['plugin', 'install', 'coder@coder-plugins'], {
    encoding: 'utf8',
  });
  const installed = addMarketplace.status === 0 && install.status === 0;
  return {
    marketplace: marketplaceDir,
    installed,
    note: installed
      ? 'Plugin installed; restart any running Claude Code session to load it.'
      : `Automatic install failed (${(install.stderr || addMarketplace.stderr || 'claude not found').trim()}); run: claude plugin marketplace add "${marketplaceDir}" && claude plugin install coder@coder-plugins`,
  };
}

/**
 * Where the Agent Skills standard copy lives - read by every harness that
 * supports the standard dir (Codex, Pi, OpenCode, Cursor, ...). This is the
 * install path for all of them, codex included. The copy is inert until a
 * harness reads it.
 */
export function agentsSkillDir(): string {
  return path.join(os.homedir(), '.agents', 'skills', 'coder');
}

// Version stamped into the installed copy's frontmatter, so `coder upgrade`
// can show the transition and future checks can detect a stale copy.
export function readAgentsSkillVersion(): string | null {
  try {
    const content = fs.readFileSync(path.join(agentsSkillDir(), 'SKILL.md'), 'utf8');
    return /^\s*version:\s*(\S+)/m.exec(content)?.[1] ?? null;
  } catch {
    return null;
  }
}

// Install the coder skill into the Agent Skills standard dir. A pure file
// copy - no host CLI is invoked and no harness needs to be installed yet; the
// copy is overwritten unconditionally so re-running refreshes it (same spirit
// as the marketplace re-add for codex/claude).
export function installAgentsSkill(marketplaceDir: string): PluginResult {
  const dest = agentsSkillDir();
  try {
    const src = path.join(marketplaceDir, 'plugins', 'agents', 'skills', 'coder');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    const skillFile = path.join(dest, 'SKILL.md');
    const stamped = fs
      .readFileSync(skillFile, 'utf8')
      .replace('\n---\n', `\nmetadata:\n  version: ${readVersion()}\n---\n`);
    fs.writeFileSync(skillFile, stamped);
    return {
      marketplace: dest,
      installed: true,
      note: 'Skill installed to ~/.agents/skills/coder; restart running sessions to load it.',
    };
  } catch (error) {
    return {
      marketplace: dest,
      installed: false,
      note: `Skill install failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Outcome of an on-demand codex install; null when codex was already present. */
export type CodexInstallResult = { installed: boolean; note: string } | null;

// Custom (OpenAI-compatible) models run on the codex engine, but users who set
// them up may never have installed Codex. It needs no login for third-party
// endpoints, so it is safe to install on their behalf. Only called when a
// custom model actually needs it; the regular codex-subscription flow still
// expects the user to install and log in themselves.
export function ensureCodexInstalled(availability: Availability): CodexInstallResult {
  if (availability.available) {
    return null;
  }
  const result = spawnSync('npm', ['install', '-g', '@openai/codex@latest'], { encoding: 'utf8' });
  return result.status === 0
    ? {
        installed: true,
        note: 'codex CLI installed (runs your custom models; no login needed for them)',
      }
    : {
        installed: false,
        note: `custom models run on the codex CLI and it is not installed; auto-install failed: ${(result.stderr || 'npm not found').trim()}. Run: npm install -g @openai/codex`,
      };
}

// Newer models are gated on the CLI version: older codex returns "requires a
// newer version of Codex", so setup keeps codex current for the default model.
// (compareVersions ignores prerelease tags, so an alpha reads as >= this.)
export const MIN_CODEX_VERSION = '0.159.1';

// First release that runs each model: openai/codex releases, anthropics/claude-code CHANGELOG.md.
const MODEL_MIN_VERSIONS: Record<'codex' | 'claude', Record<string, string>> = {
  codex: {
    'gpt-6-astra': '0.154.0',
    'gpt-6-sol': '0.156.1',
    'gpt-6-luna': '0.156.1',
    'gpt-6.1-sol': '0.159.1',
  },
  claude: { sonnet: '2.1.197', fable: '2.1.257', opus: '2.1.280' },
};

export function parseVersion(detail: string | null | undefined): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(String(detail ?? ''));
  return match ? match[1]! : null;
}

/** A warning when the installed CLI predates the model; the task still runs. */
export function modelVersionWarning(
  engine: 'codex' | 'claude',
  model: string | null | undefined,
  availability: Availability,
): string | null {
  const min = model ? MODEL_MIN_VERSIONS[engine][model] : undefined;
  const version = parseVersion(availability.detail);
  if (!min || !version || compareVersions(version, min) >= 0) return null;
  return `${engine} ${version} predates ${model} (needs ${min}), so it may fail or run another model. Run: ${engine} update`;
}

// Auto-update codex in place when it is too old for the configured default
// model. Prefer codex's own updater: it detects how codex was installed (npm,
// brew, native) and does the right thing - including refetching the binary a
// bun global install leaves missing. Fall back to npm when `codex update` is
// absent (older codex predating the subcommand) or fails. Returns a result to
// surface, or null when codex is absent or already new enough.
export function ensureCodexUpToDate(availability: Availability): CodexUpdateResult {
  if (!availability.available) {
    return null;
  }
  const version = parseVersion(availability.detail);
  if (!version || compareVersions(version, MIN_CODEX_VERSION) >= 0) {
    return null;
  }
  let result = spawnSync('codex', ['update'], { encoding: 'utf8' });
  if (result.status !== 0) {
    result = spawnSync('npm', ['install', '-g', '@openai/codex@latest'], { encoding: 'utf8' });
  }
  return result.status === 0
    ? { updated: true, from: version }
    : {
        updated: false,
        from: version,
        note: `codex ${version} is too old for the default codex model (needs >= ${MIN_CODEX_VERSION}); auto-update failed: ${(result.stderr || 'codex/npm not found').trim()}. Run: codex update`,
      };
}

export interface SetupHostReport {
  codex: { available: boolean; detail: string; auth: string; loggedIn: boolean };
  codexUpdate?: ReturnType<typeof ensureCodexUpToDate>;
  claude: { available: boolean; detail: string; auth: string; loggedIn: boolean };
  configFile: string;
  runtime: string;
  claudePlugin?: PluginResult;
  agentsSkill?: PluginResult;
  config: CoderConfig;
  ready: boolean;
}

// Print-free core: probe engines, seed the chain, install requested host plugins.
// It performs the real side effects (installs, chain seeding) - just no output.
// Hosts are named (`claude`, `agents`, or `codex` as an alias for agents) or flagged; onStart runs once they check out.
export async function setupHostCore(
  cwd: string,
  opts: { hosts?: string[]; claude?: boolean; codex?: boolean; agents?: boolean } = {},
  onStart?: () => void,
): Promise<SetupHostReport> {
  const hosts = opts.hosts ?? [];
  const unknown = hosts.find(host => !['claude', 'codex', 'agents'].includes(host));
  if (unknown)
    throw new CoderError(
      'invalid-option',
      `Unknown host "${unknown}". Use claude, codex, or agents.`,
      {
        hint: 'Codex, Pi, OpenCode, and other Agent Skills hosts: coder setup-host agents',
      },
    );
  const want = (host: 'claude' | 'codex' | 'agents') => opts[host] || hosts.includes(host);
  onStart?.();

  let availability = getCodexAvailability(cwd);
  const codexUpdate = ensureCodexUpToDate(availability);
  if (codexUpdate?.updated) {
    // Re-read so the rest of setup reflects the freshly-installed codex.
    availability = getCodexAvailability(cwd);
  }
  const auth = availability.available
    ? await getCodexAuthStatus(cwd)
    : { loggedIn: false, detail: availability.detail };
  const claude = getClaudeAvailability();
  const claudeAuth = claude.available
    ? getClaudeAuthStatus()
    : { loggedIn: false, detail: claude.detail };

  const configFile = resolveUserConfigFile();
  if (!fs.existsSync(configFile)) {
    // Seed the chain from what's installed; codex-first when neither is present.
    const chain: Engine[] = availability.available
      ? ['codex', 'claude']
      : claude.available
        ? ['claude', 'codex']
        : ['codex', 'claude'];
    writeUserConfig({ ...DEFAULT_CONFIG, chain });
  }

  const marketplaceDir = resolveMarketplaceDir();
  const claudePlugin = want('claude') ? installClaudePlugin(marketplaceDir) : null;
  // Codex, Pi, OpenCode and other Agent Skills hosts read ~/.agents/skills.
  const agentsPlugin = want('agents') || want('codex') ? installAgentsSkill(marketplaceDir) : null;

  const config = loadConfig(cwd);
  // Ready as long as one engine is usable: installed AND logged in.
  const ready =
    (availability.available && auth.loggedIn) || (claude.available && claudeAuth.loggedIn);

  return {
    codex: {
      available: availability.available,
      detail: availability.detail,
      auth: auth.detail,
      loggedIn: auth.loggedIn,
    },
    ...(codexUpdate ? { codexUpdate } : {}),
    claude: {
      available: claude.available,
      detail: claude.detail,
      auth: claudeAuth.detail,
      loggedIn: claudeAuth.loggedIn,
    },
    configFile,
    runtime: fileURLToPath(new URL('../bin/coder.mjs', import.meta.url)),
    ...(claudePlugin ? { claudePlugin } : {}),
    ...(agentsPlugin ? { agentsSkill: agentsPlugin } : {}),
    config,
    ready,
  };
}

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
    const [pmBin, ...pmArgs]: [string, ...string[]] =
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
      throw new CoderError(
        'invalid-option',
        `${pm} not found on PATH. Re-run with --pm <npm|pnpm|yarn|bun>, or update manually: ${pmBin} ${pmArgs.join(' ')}`,
      );
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim();
      throw new CoderError(
        'invalid-option',
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
