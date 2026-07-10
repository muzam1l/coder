/**
 * Runtime path/version helpers. Everything here resolves against the bundled
 * CLI entry (dist/cli.js): the build inlines all of src into that one file, so
 * `import.meta.url` points at dist/cli.js from any module, and `../` is the
 * package root.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Absolute path to the CLI entry, used to spawn detached workers and to detect
// the package manager that installed coder.
export const CLI_PATH = fileURLToPath(import.meta.url);

export function readVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// Read a plugin manifest's version off disk (fresh each call, so it reflects a
// just-completed package update). Null when the file is missing/unreadable.
export function readManifestVersion(file: string): string | null {
  try {
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

// The two marketplace manifests live at the package root (= the public repo
// root muzam1l/coder), so the marketplace dir a host installs from is the
// package root itself.
export function resolveMarketplaceDir(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}
