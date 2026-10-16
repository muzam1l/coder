// Builds the CLI beside dist and moves it in file by file, so a running `coder` never misses a file, then builds the dashboard.
// `bun scripts/build.ts dash` rebuilds the dashboard alone, keeping the previous build's assets for open pages.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

function files(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full, base) : [path.relative(base, full)];
  });
}

function readLedger(file: string): Record<string, number> {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** Move `stage` into `out` file by file, new names before the ones they replace, so a reader never misses a file; returns what `out` has that `stage` lacked. */
export function moveInto(stage: string, out: string): string[] {
  const before = new Set(files(out));
  const fresh = files(stage);
  for (const file of [...fresh.filter(f => !before.has(f)), ...fresh.filter(f => before.has(f))]) {
    mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    renameSync(path.join(stage, file), path.join(out, file));
  }
  const moved = new Set(fresh);
  return [...before].filter(file => !moved.has(file));
}

/** Remove `file` under `out`, then the directories it leaves empty. */
export function remove(out: string, file: string): void {
  rmSync(path.join(out, file), { force: true });
  for (let dir = path.dirname(file); dir !== '.'; dir = path.dirname(dir)) {
    const full = path.join(out, dir);
    if (!existsSync(full) || readdirSync(full).length) break;
    rmSync(full, { recursive: true });
  }
}

/** Everything in dist but the dashboard, its stages, and build bookkeeping. */
const cliFile = (file: string) => !/^(dash|dash\.[^/]*|\.[^/]*)(\/|$)/.test(file);

/** An .npmignore line matching this file literally, route brackets included. */
const ignoreLine = (file: string) =>
  '/' + file.replaceAll(path.sep, '/').replace(/[[\]*?!#\\()]/g, '\\$&');

/** Move a finished CLI build into place, retaining only its predecessor's dropped files. */
export function swapCli(stage: string, out: string, now = Date.now()): void {
  const ledgerFile = path.join(out, '.retired.json');
  const ledger = readLedger(ledgerFile);
  const kept: Record<string, number> = {};
  for (const file of moveInto(stage, out).filter(cliFile)) {
    if (ledger[file] !== undefined) remove(out, file);
    else kept[file] = now;
  }
  writeFileSync(ledgerFile, `${JSON.stringify(kept, null, 2)}\n`);
  writeFileSync(
    path.join(out, '.npmignore'),
    `${Object.keys(kept).map(ignoreLine).join('\n')}\n/.*\n/dash.*\n/dash/*\n!/dash/standalone/\n`,
  );
}

/** Build beside the live output, retaining only the previous build's superseded files. */
export function buildKeepingAssets(
  out: string,
  build: (stage: string) => number,
  now = Date.now(),
  stage = `${out}.next-${process.pid}`,
): number {
  rmSync(stage, { recursive: true, force: true });
  try {
    const status = build(stage);
    if (status !== 0) return status;
    const ledger = readLedger(path.join(out, 'retired.json'));
    const kept: Record<string, number> = {};
    for (const dir of ['standalone/static/assets', 'standalone/server']) {
      const current = new Set(files(path.join(stage, dir)));
      for (const name of files(path.join(out, dir))) {
        const file = path.join(dir, name);
        if (current.has(name)) continue;
        // A server bundle is only ever extended, never added beside the new one.
        if (
          dir === 'standalone/server' &&
          !existsSync(path.join(stage, dir, name.split(path.sep)[0]!))
        )
          continue;
        if (ledger[file] !== undefined) continue;
        mkdirSync(path.dirname(path.join(stage, file)), { recursive: true });
        cpSync(path.join(out, file), path.join(stage, file));
        kept[file] = now;
      }
    }
    writeFileSync(path.join(stage, 'retired.json'), `${JSON.stringify(kept, null, 2)}\n`);
    writeFileSync(
      path.join(stage, '.npmignore'),
      `${Object.keys(kept).map(ignoreLine).join('\n')}\n/retired.json\n/cache/\n`,
    );
    for (const file of moveInto(stage, out)) remove(out, file);
    return 0;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function run(root: string, args: string[], env: Record<string, string> = {}): number {
  return (
    spawnSync(args[0]!, args.slice(1), {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    }).status ?? 1
  );
}

function buildCli(root: string): number {
  const stage = `dist.next-${process.pid}`;
  rmSync(path.join(root, stage), { recursive: true, force: true });
  try {
    let status = run(root, ['bunx', 'tsdown'], { CODER_DIST: stage });
    if (status === 0)
      status = run(root, [
        'bunx',
        'prettier',
        '--write',
        `${stage}/**/*.d.ts`,
        '--log-level',
        'warn',
      ]);
    if (status === 0) {
      packRunner(root, path.join(root, stage));
      swapCli(path.join(root, stage), path.join(root, 'dist'));
    }
    return status;
  } finally {
    rmSync(path.join(root, stage), { recursive: true, force: true });
  }
}

export function packPackage(root: string, out = root): string {
  const packed = spawnSync(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--workspaces=false', '--pack-destination', out],
    { cwd: root, encoding: 'utf8' },
  );
  if (packed.status !== 0) throw new Error(packed.stderr || 'Coder package build failed');
  const [{ filename }] = Object.values(JSON.parse(packed.stdout)) as { filename: string }[];

  return filename;
}

export function packRunner(root: string, stage: string): void {
  const copy = mkdtempSync(path.join(os.tmpdir(), 'coder-runner-'));
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    writeFileSync(
      path.join(copy, 'package.json'),
      JSON.stringify({ ...pkg, files: ['bin', 'dist'] }),
    );
    cpSync(path.join(root, 'bin'), path.join(copy, 'bin'), { recursive: true });
    cpSync(stage, path.join(copy, 'dist'), { recursive: true });
    const archive = path.join(copy, packPackage(copy));
    const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
    renameSync(archive, path.join(stage, 'runner.tgz'));
    writeFileSync(path.join(stage, 'runner.json'), `${JSON.stringify({ hash })}\n`);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

function buildDash(root: string): number {
  const local = path.join(root, 'node_modules/.bin/pnext');
  // A copy of the package whose relative outDir lands in the stage.
  const copy = path.join(root, `dist/.dash-build-${process.pid}`);
  return buildKeepingAssets(path.join(root, 'dist/dash'), stage => {
    rmSync(copy, { recursive: true, force: true });
    cpSync(path.join(root, 'src'), path.join(copy, 'src'), { recursive: true });
    for (const file of ['package.json', 'tsconfig.json'])
      cpSync(path.join(root, file), path.join(copy, file));
    const cache = path.join(root, 'dist/dash/cache');
    if (existsSync(cache)) cpSync(cache, path.join(copy, 'dist/dash/cache'), { recursive: true });
    try {
      const built = run(root, [
        existsSync(local) ? local : 'pnext',
        'build',
        path.join(copy, 'src/server/dash'),
      ]);
      if (built === 0) renameSync(path.join(copy, 'dist/dash'), stage);
      return built;
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, '..');
  process.exit(process.argv[2] === 'dash' ? buildDash(root) : buildCli(root) || buildDash(root));
}
