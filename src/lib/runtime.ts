/**
 * Runtime path/version helpers. The build emits several bundles (dist/cli.js,
 * dist/sdk.js, dist/flow/index.js), each with its own inlined copy of this
 * module, so nothing may assume where `import.meta.url` landed. Everything
 * anchors on the package root, found by walking up to our package.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const pkg = path.join(dir, 'package.json');
    try {
      if (JSON.parse(fs.readFileSync(pkg, 'utf8')).name === '@wular/coder') {
        return dir;
      }
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Unreachable in a real install; fall back to the old cli.js assumption.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

const PACKAGE_ROOT = findPackageRoot();

// Absolute path to the CLI entry, used to spawn detached workers and to detect
// the package manager that installed coder. Falls back to the TS source when
// running unbundled (dev).
export const CLI_PATH = fs.existsSync(path.join(PACKAGE_ROOT, 'dist/cli.js'))
  ? path.join(PACKAGE_ROOT, 'dist/cli.js')
  : path.join(PACKAGE_ROOT, 'src/cli.ts');

export function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      version?: string;
    };
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
  return PACKAGE_ROOT;
}
