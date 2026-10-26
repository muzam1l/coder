/** An agent's skill repositories on a task's machine: each fetched at one commit, sparse to its skill folders, beside the checkout; then linked where Claude (`--add-dir`) and Codex (`$HOME/.agents/skills`) list skills. */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { SkillSource } from '../agent/types';
import { INTEGRATIONS } from '../integrations';
import { processTiming } from '../utils/process';
import { repositoryCache, validRef, withCheckoutLock, withGitToken } from './task';

/** A skill source as the server hands it to the runner. */
export type RemoteSkill = SkillSource & { cloneUrl: string; token?: string };

const exec = promisify(execFile);
const FETCH_MS = 30_000;
/** The skills folders of a repository, and the engine that lists each. */
const SOURCE_FOLDERS = ['.claude/skills', '.agents/skills'];

/** Each source's checkout in order, `undefined` for one skipped with a warning; a local or http runner's are worktrees of its machine's checkout cache. */
export async function fetchSkills(
  sources: RemoteSkill[],
  root: string,
  runner: string,
  warn: (message: string) => void,
  signal?: AbortSignal,
): Promise<Array<string | undefined>> {
  const machine = ['local', 'http'].includes(runner);
  // A continuation reuses the task's folder; its skills are fetched and linked again.
  await fs.rm(path.join(root, 'skills'), { recursive: true, force: true });

  return Promise.all(
    sources.map((source, index) =>
      fetchSource(source, path.join(root, 'skills', 'sources', String(index)), root, machine, {
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(FETCH_MS)]),
        maxBuffer: 64 * 1024 * 1024,
      }).catch((error: unknown) => {
        warn(
          `Skills from ${source.repo} are skipped, the repository could not be fetched (${error instanceof Error ? error.message : String(error)}).`,
        );
        return undefined;
      }),
    ),
  );
}

async function fetchSource(
  source: RemoteSkill,
  dir: string,
  root: string,
  machine: boolean,
  options: { signal: AbortSignal; maxBuffer: number },
): Promise<string> {
  const revision = source.sha ?? source.ref ?? 'HEAD';
  const clone = new URL(source.cloneUrl);
  const hosts = Object.values(INTEGRATIONS).flatMap(entry => entry.repos?.cloneHosts ?? []);
  if (clone.protocol !== 'https:' || !hosts.includes(clone.hostname))
    throw new Error('the clone host is not a known repository host');
  if (!validRef(revision) || source.path?.split('/').some(part => !part || /^\.+$/.test(part)))
    throw new Error('invalid ref or path');
  const sparse = source.path ? [`/${source.path}/`] : SOURCE_FOLDERS.map(folder => `/${folder}/`);
  const [owner = '', name = ''] = source.repo.split('/');
  const cache = machine ? repositoryCache(source.cloneUrl, owner, name) : undefined;

  await withGitToken(root, source.token, clone.hostname, async auth => {
    const git = (...args: string[]) => exec('git', args, { ...auth, ...options });
    if (!cache) {
      await fs.mkdir(dir, { recursive: true });
      await git('-C', dir, 'init', '-q');
      await git('-C', dir, 'remote', 'add', 'origin', source.cloneUrl);
      await git('-C', dir, 'sparse-checkout', 'set', '--no-cone', ...sparse);
      await git('-C', dir, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', revision);
      await git('-C', dir, 'checkout', '-q', '--detach', 'FETCH_HEAD');
      return;
    }

    await withCheckoutLock(cache, async () => {
      if (!(await fs.stat(path.join(cache, '.git')).catch(() => undefined))) {
        const staging = await fs.mkdtemp(`${cache}-clone-`);
        try {
          await git('-C', staging, 'init', '-q');
          await git('-C', staging, 'remote', 'add', 'origin', source.cloneUrl);
          await fs.rename(staging, cache);
        } finally {
          await fs.rm(staging, { recursive: true, force: true });
        }
      }
      await git('-C', cache, 'worktree', 'prune', '--expire', 'now');
      await git('-C', cache, 'remote', 'set-url', 'origin', source.cloneUrl);
      // A pinned commit already in the cache needs no fetch.
      const cached =
        source.sha &&
        (await git('-C', cache, 'cat-file', '-e', `${source.sha}^{commit}`).then(
          () => true,
          () => false,
        ));
      if (!cached) await git('-C', cache, 'fetch', '-q', '--depth', '1', 'origin', revision);
      const commit = cached ? source.sha! : 'FETCH_HEAD';
      await git('-C', cache, 'worktree', 'add', '-q', '--no-checkout', '--detach', dir, commit);
    });
    await git('-C', dir, 'sparse-checkout', 'set', '--no-cone', ...sparse);
    await git('-C', dir, 'checkout', '-q', '--detach', 'HEAD');
  });

  return dir;
}

/** Links each fetched source's skill folders, the ones with a `SKILL.md`, into a folder Claude adds and a home Codex reads; a name the checkout's own skills folder or an earlier source has is skipped with a log line. Undefined when nothing was linked. */
export async function linkSkills(
  sources: RemoteSkill[],
  fetched: Array<string | undefined>,
  cwd: string,
  root: string,
  note: (message: string) => void,
): Promise<{ claude: string; home: string } | undefined> {
  const claude = path.join(root, 'skills', 'claude');
  const home = path.join(root, 'skills', 'home');
  const engines = [
    { name: 'Claude', target: path.join(claude, '.claude', 'skills'), taken: new Set<string>() },
    { name: 'Codex', target: path.join(home, '.agents', 'skills'), taken: new Set<string>() },
  ];
  for (const [index, engine] of engines.entries()) {
    await fs.mkdir(engine.target, { recursive: true });
    for (const name of await names(path.join(cwd, SOURCE_FOLDERS[index]!))) engine.taken.add(name);
  }
  await mirrorHome(home);
  // The person's own Codex skills, mirrored into the home, come first.
  for (const name of await names(engines[1]!.target)) engines[1]!.taken.add(name);
  let linked = 0;

  for (const [index, dir] of fetched.entries()) {
    if (!dir) continue;
    const source = sources[index]!;
    const folders = source.path
      ? [path.join(dir, source.path)]
      : SOURCE_FOLDERS.map(folder => path.join(dir, folder));
    for (const folder of folders)
      for (const name of await names(folder)) {
        const skill = path.join(folder, name);
        if (!(await fs.stat(path.join(skill, 'SKILL.md')).catch(() => undefined))) continue;
        const skipped = engines.filter(engine => engine.taken.has(name));
        if (skipped.length)
          note(
            `Skill ${name} from ${source.repo} is skipped for ${skipped.map(engine => engine.name).join(' and ')}, a skill by that name comes first.`,
          );
        for (const engine of engines)
          if (!skipped.includes(engine)) {
            await fs.symlink(skill, path.join(engine.target, name));
            engine.taken.add(name);
            linked++;
          }
      }
  }

  processTiming('runner.skills.done');

  return linked ? { claude, home } : undefined;
}

/** `home` stands in for this machine's home: every entry links to the real one, `.agents/skills` gets its own folder holding the person's skills. */
async function mirrorHome(home: string): Promise<void> {
  const real = process.env.HOME || os.homedir();
  const link = (from: string, to: string, skip: string) =>
    names(from).then(entries =>
      Promise.all(
        entries
          .filter(entry => entry !== skip)
          .map(entry => fs.symlink(path.join(from, entry), path.join(to, entry))),
      ),
    );

  await Promise.all([
    link(real, home, '.agents'),
    link(path.join(real, '.agents'), path.join(home, '.agents'), 'skills'),
    link(path.join(real, '.agents', 'skills'), path.join(home, '.agents', 'skills'), ''),
  ]);
}

const names = (dir: string) => fs.readdir(dir).catch(() => [] as string[]);
