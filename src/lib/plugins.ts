/**
 * Host-plugin installation and codex version gating, shared by `coder setup`
 * and `coder upgrade`.
 */
import { spawnSync } from 'node:child_process';

import { compareVersions } from './update-check.js';
import type { Availability } from './types.js';

/** Result of a plugin install/refresh attempt. */
export interface PluginResult {
  marketplace: string;
  installed: boolean;
  note: string;
}

/** Outcome of the codex auto-update check; null when nothing to do. */
export type CodexUpdateResult =
  | { updated: true; from: string }
  | { updated: false; from: string; note: string }
  | null;

// Register the packaged marketplace with codex and install the coder plugin
// from it, exactly what a user would type by hand. Re-adding refreshes both the
// marketplace snapshot and the cached plugin copy (codex caches installs per
// version). "." is added from inside the dir because codex parses "@" in a path
// argument (node_modules/@wular/...) as a git owner/repo@ref source.
export function installCodexPlugin(marketplaceDir: string): PluginResult {
  spawnSync('codex', ['plugin', 'remove', 'coder@coder-plugins'], { encoding: 'utf8' });
  spawnSync('codex', ['plugin', 'marketplace', 'remove', 'coder-plugins'], { encoding: 'utf8' });
  const addMarketplace = spawnSync('codex', ['plugin', 'marketplace', 'add', '.'], {
    cwd: marketplaceDir,
    encoding: 'utf8',
  });
  const addPlugin = spawnSync('codex', ['plugin', 'add', 'coder@coder-plugins'], {
    encoding: 'utf8',
  });
  const installed = addMarketplace.status === 0 && addPlugin.status === 0;
  return {
    marketplace: marketplaceDir,
    installed,
    note: installed
      ? 'Plugin installed; restart any running codex session to load it.'
      : `Automatic install failed (${(addPlugin.stderr || addMarketplace.stderr || 'codex not found').trim()}); run: codex plugin marketplace add "${marketplaceDir}" && codex plugin add coder@coder-plugins`,
  };
}

// Same through the claude CLI's plugin commands.
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

/** Outcome of an on-demand codex install; null when codex was already present. */
export type CodexInstallResult = { installed: boolean; note: string } | null;

// Custom (OpenAI-compatible) models run on the codex engine, but users who set
// them up may never have installed codex — it needs no login for third-party
// endpoints, so it is safe to install on their behalf. Only called when a
// custom model actually needs it; the regular codex-subscription flow still
// expects the user to install and log in themselves.
export function ensureCodexInstalled(availability: Availability): CodexInstallResult {
  if (availability.available) {
    return null;
  }
  const result = spawnSync('npm', ['install', '-g', '@openai/codex@latest'], { encoding: 'utf8' });
  return result.status === 0
    ? { installed: true, note: 'codex CLI installed (runs your custom models; no login needed for them)' }
    : {
        installed: false,
        note: `custom models run on the codex CLI and it is not installed; auto-install failed: ${(result.stderr || 'npm not found').trim()}. Run: npm install -g @openai/codex`,
      };
}

// GPT-5.6 codex models are gated server-side on the codex CLI version: older
// codex returns "requires a newer version of Codex". The default codex model is
// a 5.6 tier, so setup keeps codex current. Bump when a newer model raises the
// floor. (compareVersions ignores prerelease tags, so an alpha reads as >= this.)
export const MIN_CODEX_VERSION = '0.144.0';

export function parseCodexVersion(detail: string | null | undefined): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(String(detail ?? ''));
  return match ? match[1]! : null;
}

// Auto-update codex in place when it is too old for the configured GPT-5.6
// model. Prefer codex's own updater: it detects how codex was installed (npm,
// brew, native) and does the right thing - including refetching the binary a
// bun global install leaves missing. Fall back to npm when `codex update` is
// absent (older codex predating the subcommand) or fails. Returns a result to
// surface, or null when codex is absent or already new enough.
export function ensureCodexUpToDate(availability: Availability): CodexUpdateResult {
  if (!availability.available) {
    return null;
  }
  const version = parseCodexVersion(availability.detail);
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
        note: `codex ${version} is too old for the default GPT-5.6 model (needs >= ${MIN_CODEX_VERSION}); auto-update failed: ${(result.stderr || 'codex/npm not found').trim()}. Run: codex update`,
      };
}
