/**
 * Host-plugin installation and codex version gating, shared by `coder setup`
 * and `coder upgrade`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// Cursor has no plugin-install CLI, but it does auto-discover local plugins from
// ~/.cursor/plugins/local/<name>/ (a plugin is a dir with .cursor-plugin/plugin.json
// bundling skills/rules/mcp). So "installing" is copying the packaged coder plugin
// there - the same artifact you'd publish to the Cursor marketplace, minus the web
// submission. No engine host, no subagent (a Cursor agent can't spawn one); the
// bundled handle skill just drives the coder CLI. The install dir must match the
// manifest `name` ("coder").
export function installCursorPlugin(marketplaceDir: string): PluginResult {
  const source = path.join(marketplaceDir, 'plugins', 'cursor');
  const localRoot = path.join(os.homedir(), '.cursor', 'plugins', 'local');
  const target = path.join(localRoot, 'coder');
  try {
    if (!fs.existsSync(path.join(source, '.cursor-plugin', 'plugin.json'))) {
      throw new Error(`packaged plugin not found at ${source}`);
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(localRoot, { recursive: true });
    fs.cpSync(source, target, { recursive: true });
    return {
      marketplace: localRoot,
      installed: true,
      note: `Plugin installed to ${target}; reload the Cursor window (or restart Cursor) to load it.`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      marketplace: localRoot,
      installed: false,
      note: `Automatic install failed (${detail}); copy the plugin by hand: cp -r "${source}" "${target}"`,
    };
  }
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
