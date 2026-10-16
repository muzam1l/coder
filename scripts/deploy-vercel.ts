import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { packPackage } from './build';

export function prepareVercel(root: string, out: string): void {
  mkdirSync(out, { recursive: true });
  for (const name of readdirSync(out))
    if (name !== '.vercel') rmSync(path.join(out, name), { recursive: true, force: true });
  cpSync(path.join(root, 'src/server/deploy/vercel'), out, { recursive: true });
  const pkg = JSON.parse(readFileSync(path.join(out, 'package.json'), 'utf8'));
  pkg.dependencies['@wular/coder'] = `file:./${packPackage(root, out)}`;
  writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
}

if (import.meta.main) {
  if (process.argv.slice(2).some(arg => arg !== '--prod'))
    throw new Error('Usage: bun run deploy:vercel [--prod]');
  const root = path.resolve(import.meta.dir, '..');
  const built = spawnSync('bun', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (built.status !== 0) process.exit(built.status ?? 1);
  const out = path.join(root, '.vercel/deploy');
  prepareVercel(root, out);
  const deployed = spawnSync('vercel', process.argv.slice(2), { cwd: out, stdio: 'inherit' });
  process.exit(deployed.status ?? 1);
}
