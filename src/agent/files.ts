import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

type IgnoreRule = { pattern: RegExp; negate: boolean; directory: boolean };

const GLOB: Record<string, string> = {
  '**/': '(?:.*/)?',
  '/**': '/.*',
  '**': '.*',
  '*': '[^/]*',
  '?': '[^/]',
};

/** Common `.gitignore` forms; no character classes or escaped leading `#` and `!`. */
function ignoreRules(text: string): IgnoreRule[] {
  return text.split(/\r?\n/).flatMap(line => {
    let rule = line.trimEnd();
    if (!rule || rule.startsWith('#')) return [];
    const negate = rule.startsWith('!');
    if (negate) rule = rule.slice(1);
    const directory = rule.endsWith('/');
    if (directory) rule = rule.slice(0, -1);
    const glob = rule
      .replace(/^\//, '')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\/|\/\*\*$|\*\*|\*|\?/g, token => GLOB[token]!);
    const anchored = rule.includes('/');
    return [
      {
        pattern: new RegExp(anchored ? `^${glob}$` : `^(?:.*/)?${glob}$`),
        negate,
        directory,
      },
    ];
  });
}

const ignored = (rules: IgnoreRule[], name: string, directory: boolean) =>
  rules.reduce(
    (result, rule) =>
      (!rule.directory || directory) && rule.pattern.test(name) ? !rule.negate : result,
    false,
  );

/** Every file under `root`, skipping symlinks and what the rules ignore. */
async function walk(root: string, rules: IgnoreRule[], relative = ''): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await fs.readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !ignored(rules, name, true))
      names.push(...(await walk(root, rules, name)));
    else if (entry.isFile() && !ignored(rules, name, false)) names.push(name);
  }
  return names;
}

/** Files git would add from the folder, or undefined outside a work tree. */
async function gitFiles(root: string): Promise<string[] | undefined> {
  const listed = await promisify(execFile)(
    'git',
    ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
    { maxBuffer: 64 * 1024 * 1024 },
  ).catch(() => undefined);
  return listed?.stdout.split('\0').filter(Boolean);
}

/** Files in an agent folder besides `agent.json` and `system.md`, by relative path; ignored files stay local. */
export async function folderFiles(root: string): Promise<Record<string, string>> {
  const names =
    (await gitFiles(root)) ??
    (await walk(
      root,
      ignoreRules(await fs.readFile(path.join(root, '.gitignore'), 'utf8').catch(() => '')),
    ));
  const result: Record<string, string> = {};
  for (const name of names) {
    if (name === 'agent.json' || name === 'system.md') continue;
    const file = path.join(root, name);
    if ((await fs.lstat(file).catch(() => undefined))?.isFile())
      result[name] = await fs.readFile(file, 'utf8');
  }
  return result;
}
