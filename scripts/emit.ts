// Writes docs/cli and the host skills from the command definitions; `bun run build` runs it before tsdown.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { markdown, skills } from 'contextjsx/emit';

import { cli } from '../src/cmd';
import { SKILLS } from '../src/context';

/** Every emitted file, by path relative to the package root. */
export function emitted(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [file, text] of Object.entries(markdown(cli))) files[`docs/cli/${file}`] = text;
  for (const [host, skill] of Object.entries(SKILLS))
    for (const [file, text] of Object.entries(skills({ ...cli, skills: [skill] })))
      files[`plugins/${host}/skills/${file}`] = text;

  return files;
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, '..');
  rmSync(path.join(root, 'docs/cli'), { recursive: true, force: true });
  for (const [file, text] of Object.entries(emitted())) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
}
