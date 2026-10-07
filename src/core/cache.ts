import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { coderCache, coderHome } from './state';
import { moveDirectoryAsync } from '../utils/fsx';

export interface CacheMigration {
  cache: string;
  tasks: number;
  flows: number;
  files: number;
}

async function entries(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function moveBin(from: string, to: string): Promise<number> {
  if (from === to || !(await exists(from))) return 0;
  const children = await entries(from);
  const count = children.filter(entry => entry.isDirectory()).length;
  if (!(await exists(to))) {
    await moveDirectoryAsync(from, to);
    return count;
  }
  for (const child of children) {
    await moveDirectoryAsync(path.join(from, child.name), path.join(to, child.name));
  }
  await fs.rmdir(from);

  return count;
}

async function cleanUsageTemps(file: string): Promise<void> {
  const dir = path.dirname(file);
  const name = path.basename(file);
  for (const entry of await entries(dir)) {
    const suffix = entry.name.startsWith(name) ? entry.name.slice(name.length) : '';
    if (!entry.isFile() || !(suffix === '.tmp' || /^\.\d+(?:\.[a-f0-9-]{36})?\.tmp$/.test(suffix)))
      continue;
    const pid = Number(entry.name.slice(name.length + 1).split('.')[0]);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
      }
    }
    await fs.unlink(path.join(dir, entry.name)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function moveUsage(from: string, to: string): Promise<number> {
  await cleanUsageTemps(from);
  if (from === to || !(await exists(from))) return 0;
  if (!(await exists(to))) {
    await moveDirectoryAsync(from, to);
    return 1;
  }
  const old = JSON.parse(await fs.readFile(from, 'utf8'));
  const current = JSON.parse(await fs.readFile(to, 'utf8'));
  const merged = {
    ...old,
    ...current,
    ...(old.rows || current.rows ? { rows: { ...old.rows, ...current.rows } } : {}),
  };
  const temp = `${to}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(merged)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, to);
    await fs.unlink(from);
  } finally {
    await fs.rm(temp, { force: true });
  }

  return 1;
}

/** Migrate old storage after listening; only interrupted usage writes are discarded. */
export async function migrateCache(): Promise<CacheMigration> {
  const cache = coderCache();
  const state = coderHome('state');
  const archive = coderCache('archive');
  const flows = coderCache('flows-archived');
  const usage = coderCache('usage.json');
  const runnerUsage = coderCache('runner', 'usage.json');
  const checkouts = { from: coderHome('checkouts'), to: coderCache('checkouts') };
  const update = { from: coderHome('update-check.json'), to: coderCache('update-check.json') };
  const result: CacheMigration = { cache, tasks: 0, flows: 0, files: 0 };
  const roots = (await entries(state))
    .filter(entry => entry.isDirectory())
    .map(entry => ({
      archive: coderHome('state', entry.name, 'archive'),
      flows: coderHome('state', entry.name, 'flows-archived'),
      usage: coderHome('state', entry.name, 'usage.json'),
      runnerUsage: coderHome('state', entry.name, 'runner', 'usage.json'),
    }));
  await cleanUsageTemps(usage);
  await cleanUsageTemps(runnerUsage);
  for (const root of roots) {
    result.tasks += await moveBin(root.archive, archive);
    result.flows += await moveBin(root.flows, flows);
    result.files += await moveUsage(root.usage, usage);
    result.files += await moveUsage(root.runnerUsage, runnerUsage);
  }
  await moveBin(checkouts.from, checkouts.to);
  result.files += await moveUsage(update.from, update.to);

  return result;
}
