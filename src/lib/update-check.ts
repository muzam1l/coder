/**
 * Passive update notifier + self-upgrade helpers.
 *
 * A global install (npm/pnpm/yarn/bun) is frozen at the version that was latest
 * when the user ran install; the package manager never revisits it. So we nudge:
 * on a user-facing command we print a one-line notice when a newer version is
 * cached, and kick off a detached background refresh of that cache when it is
 * stale (>24h). The notice is always one cycle behind the registry (like npm's
 * own update-notifier) so the check never blocks the command.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

import { resolveCoderHome } from './state.js';
import { errStyle } from './ui.js';

const PKG = '@wular/coder';
const REGISTRY = `https://registry.npmjs.org/${PKG}/latest`;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Persisted update-check cache written to CODER_HOME/update-check.json. */
interface UpdateCache {
  checkedAt?: number;
  latest?: string | null;
  current?: string;
}

/** The package manager that owns this install and the upgrade command for it. */
interface PackageManagerInfo {
  pm: string;
  command: string[];
}

function cacheFile(): string {
  return path.join(resolveCoderHome(), 'update-check.json');
}

/** Numeric x.y.z compare; prerelease tags are ignored (our versions are plain). */
export function compareVersions(a: string, b: string): number {
  const pa = String(a)
    .split('.')
    .map(n => parseInt(n, 10) || 0);
  const pb = String(b)
    .split('.')
    .map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
  }
  return 0;
}

function readCache(): UpdateCache | null {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as UpdateCache;
  } catch {
    return null;
  }
}

function writeCache(data: UpdateCache) {
  try {
    fs.mkdirSync(resolveCoderHome(), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify(data));
  } catch {
    // best-effort; never break a command over the update cache
  }
}

export function clearUpdateCache() {
  try {
    fs.rmSync(cacheFile(), { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Print an update notice to stderr when a newer version is cached, and trigger
 * a detached background refresh when the cache is stale. Non-blocking; never
 * throws. Suppressed by CODER_NO_UPDATE_CHECK or CI.
 */
export function maybeNotifyUpdate(currentVersion: string, cliPath: string) {
  if (process.env.CODER_NO_UPDATE_CHECK || process.env.CI) return;

  const cache = readCache();
  if (cache?.latest && compareVersions(cache.latest, currentVersion) > 0) {
    process.stderr.write(
      errStyle.dim(`coder ${currentVersion} -> `) +
        errStyle.bold(cache.latest) +
        errStyle.dim(' available. run: coder upgrade\n\n'),
    );
  }

  const stale = !cache?.checkedAt || Date.now() - cache.checkedAt > MAX_AGE_MS;
  if (stale) {
    try {
      const child = spawn(process.execPath, [cliPath, '_refreshUpdate'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Hidden-command body: fetch the latest published version and write the cache.
 * Bumps checkedAt even on failure (so an offline machine backs off for a day
 * instead of spawning a refresher every run) while preserving the last-known
 * latest.
 */
export async function refreshUpdateCache(currentVersion: string) {
  const prev = readCache();
  let latest: string | null = prev?.latest ?? null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(REGISTRY, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    clearTimeout(timer);
    if (res.ok) {
      const body = await res.json();
      if (body?.version) latest = body.version;
    }
  } catch {
    /* offline / registry down: keep prior latest, just back off */
  }
  writeCache({ checkedAt: Date.now(), latest, current: currentVersion });
}

/**
 * Work out which package manager owns this install from the real path of the
 * running file, so `coder upgrade` uses the same manager that installed it
 * (npm/pnpm/yarn/bun) instead of assuming npm. Falls back to npm.
 */
export function detectPackageManager(cliPath: string): PackageManagerInfo {
  let real = cliPath;
  try {
    real = fs.realpathSync(cliPath);
  } catch {
    /* keep the un-resolved path */
  }
  const p = real.replace(/\\/g, '/');

  if (/\/\.bun\//.test(p)) {
    return { pm: 'bun', command: ['bun', 'add', '-g', `${PKG}@latest`] };
  }
  if (/\/\.pnpm\//.test(p) || /\/pnpm(-global)?\//i.test(p) || /\/Library\/pnpm\//.test(p)) {
    return { pm: 'pnpm', command: ['pnpm', 'add', '-g', `${PKG}@latest`] };
  }
  if (
    /\/\.config\/yarn\/global\//.test(p) ||
    /\/yarn\/global\//.test(p) ||
    /\/Yarn\/Data\/global\//.test(p)
  ) {
    return { pm: 'yarn', command: ['yarn', 'global', 'add', `${PKG}@latest`] };
  }
  return { pm: 'npm', command: ['npm', 'install', '-g', `${PKG}@latest`] };
}
