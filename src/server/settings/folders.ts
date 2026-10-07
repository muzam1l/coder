import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LocalFolder, LocalFolders } from '../../client/types';
import { listTasks, listArchivedTasks, coderCache } from '../../core/state';
import { withCheckoutLock } from '../../runner/task';

export function checkFolder(
  value: unknown,
): { ok: true; folder: LocalFolder } | { ok: false; detail: string } {
  if (typeof value !== 'string' || !value)
    return { ok: false, detail: 'A folder path is required' };
  const directory =
    value === '~'
      ? os.homedir()
      : value.startsWith('~/')
        ? path.join(os.homedir(), value.slice(2))
        : value;
  if (!path.isAbsolute(directory)) return { ok: false, detail: 'The folder path must be absolute' };
  const resolved = path.normalize(directory);
  try {
    if (!fs.statSync(resolved).isDirectory())
      return { ok: false, detail: 'The path is not a directory' };
    fs.accessSync(resolved, fs.constants.R_OK);
    return { ok: true, folder: { path: resolved, name: path.basename(resolved) } };
  } catch {
    return { ok: false, detail: 'The folder does not exist or is not readable' };
  }
}

export function localFolders(cwd: string): LocalFolders {
  const folders = new Map<string, LocalFolder>();
  const tasks = [...listTasks(cwd), ...listArchivedTasks(cwd, { migrate: false })].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
  for (const task of tasks) {
    const checked = checkFolder(task.cwd);
    if (!checked.ok || folders.has(checked.folder.path)) continue;
    folders.set(checked.folder.path, { ...checked.folder, recent: Date.parse(task.createdAt) });
    if (folders.size === 8) break;
  }
  return {
    current: { path: cwd, name: path.basename(cwd) },
    recent: [...folders.values()],
    picker: Boolean(dialog()),
  };
}

const onPath = (bin: string) =>
  (process.env.PATH ?? '')
    .split(path.delimiter)
    .some(dir => dir && fs.existsSync(path.join(dir, bin)));

/** The machine's own folder dialog, if it has one. */
function dialog(): [string, string[]] | undefined {
  const prompt = 'Choose a folder for the task';
  if (process.platform === 'darwin')
    return [
      'osascript',
      [
        '-e',
        'tell application "System Events"',
        '-e',
        'activate',
        '-e',
        `POSIX path of (choose folder with prompt "${prompt}")`,
        '-e',
        'end tell',
      ],
    ];
  if (process.platform === 'win32')
    return [
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '${prompt}'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }`,
      ],
    ];
  if (onPath('zenity')) return ['zenity', ['--file-selection', '--directory', `--title=${prompt}`]];
  if (onPath('kdialog'))
    return ['kdialog', ['--getexistingdirectory', os.homedir(), '--title', prompt]];
  return undefined;
}

/** Opens the machine's folder dialog and waits; a closed dialog is `{ ok: false, detail: "" }`. */
export async function pickFolder(): Promise<
  { ok: true; folder: LocalFolder } | { ok: false; detail: string }
> {
  const chooser = dialog();
  if (!chooser)
    return { ok: false, detail: 'This machine has no folder dialog; type a path instead' };
  try {
    const { stdout } = await promisify(execFile)(chooser[0], chooser[1], { timeout: 10 * 60_000 });
    const chosen = stdout.trim().replace(/(.)[\\/]+$/, '$1');
    return chosen ? checkFolder(chosen) : { ok: false, detail: '' };
  } catch {
    return { ok: false, detail: '' };
  }
}

/** `https://host/owner/repo` or `git@host:owner/repo` as its host and path segments. */
function repoPath(url: string): string[] | undefined {
  const scp = /^\w[\w.-]*@([\w.-]+):(?!\/)([^?#]+)$/.exec(url);
  const parsed = scp || !URL.canParse(url) ? undefined : new URL(url);
  if (
    !scp &&
    (!parsed ||
      !['https:', 'ssh:'].includes(parsed.protocol) ||
      parsed.password ||
      parsed.search ||
      parsed.hash)
  )
    return;
  const [host, segments] = scp
    ? [scp[1]!, scp[2]!]
    : [parsed!.port ? `${parsed!.hostname}_${parsed!.port}` : parsed!.hostname, parsed!.pathname];
  const parts = segments
    .replace(/(\.git)?\/?$/, '')
    .split('/')
    .filter(Boolean);
  if (
    !/^[a-z0-9][a-z0-9._-]*$/i.test(host) ||
    parts.length < 2 ||
    !parts.every(part => /^[\w.-]+$/.test(part) && !/^\.+$/.test(part))
  )
    return;
  return [host.toLowerCase(), ...parts];
}

/** Clones a git URL with the machine's own git logins into the runners' checkout cache, or fetches it there again. */
export async function cloneFolder(
  value: unknown,
): Promise<{ ok: true; folder: LocalFolder } | { ok: false; detail: string }> {
  const url = typeof value === 'string' ? value.trim() : '';
  const parts = repoPath(url);
  if (!parts)
    return { ok: false, detail: 'Use an https or ssh git URL, like https://github.com/owner/repo' };
  const cache = coderCache('checkouts', ...parts);
  const signal = AbortSignal.timeout(10 * 60_000);
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
  };
  const git = (args: string[]) =>
    promisify(execFile)('git', args, { env, signal, maxBuffer: 64 * 1024 * 1024 });
  try {
    await withCheckoutLock(cache, async () => {
      if (fs.existsSync(path.join(cache, '.git'))) {
        await git(['-C', cache, 'remote', 'set-url', 'origin', url]);
        return void (await git(['-C', cache, 'fetch', 'origin']));
      }
      const staging = await fs.promises.mkdtemp(`${cache}-clone-`);
      try {
        await git(['clone', '--', url, staging]);
        await fs.promises.rename(staging, cache);
      } finally {
        await fs.promises.rm(staging, { recursive: true, force: true });
      }
    });
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & { stderr?: string };
    if (signal.aborted) return { ok: false, detail: 'The clone took longer than 10 minutes' };
    if (failed.code === 'ENOENT' && !failed.stderr)
      return { ok: false, detail: 'Git is not installed on this machine' };
    const lines = String(failed.stderr ?? failed.message)
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    const line = (
      lines.find(each => each.startsWith('fatal:')) ??
      lines.at(-1) ??
      'The clone failed'
    ).replace(/^fatal:\s*/, '');
    return { ok: false, detail: line[0]!.toUpperCase() + line.slice(1) };
  }
  return { ok: true, folder: { path: cache, name: parts.at(-1)!, url } };
}
