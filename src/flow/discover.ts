/** Flow name/path resolution. See docs/flows.md "Where flows live". */
import fs from 'node:fs';
import path from 'node:path';

import { coderHome, resolveWorkspaceRoot } from '../core/state';
import { fileURLToPath } from 'node:url';
import type { DiscoveredFlow } from './types';

const EXTS = ['.ts', '.mjs', '.js'];

/** Flows shipped with coder: `src/flow/builtin` in development, `dist/flow/builtin` under any dist bundle. */
export function builtinFlowsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  while (path.basename(dir) !== 'dist' && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return path.basename(dir) === 'dist'
    ? path.join(dir, 'flow', 'builtin')
    : path.join(here, 'builtin');
}

export function flowsIn(dir: string, scope: DiscoveredFlow['scope']): DiscoveredFlow[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const found: DiscoveredFlow[] = [];
  for (const file of names.sort()) {
    const ext = path.extname(file);
    if (EXTS.includes(ext) && !file.endsWith('.d.ts')) {
      found.push({
        name: path.basename(file, ext),
        path: path.join(dir, file),
        scope,
      });
      continue;
    }
    // A folder flow: <name>/index.<ext>, free to import its own siblings.
    const index = EXTS.map(e => path.join(dir, file, `index${e}`)).find(f => fs.existsSync(f));
    if (index) found.push({ name: file, path: index, scope });
  }
  return found;
}

// .coder/flows dirs from cwd up to the repo root (nearest first), then the
// global dir.
function flowDirs(cwd: string): { dir: string; scope: DiscoveredFlow['scope'] }[] {
  const root = resolveWorkspaceRoot(cwd);
  const dirs: { dir: string; scope: DiscoveredFlow['scope'] }[] = [];
  let current = path.resolve(cwd);
  for (;;) {
    dirs.push({
      dir: path.join(current, '.coder', 'flows'),
      scope: 'workspace',
    });
    if (current === root || path.dirname(current) === current) {
      break;
    }
    current = path.dirname(current);
  }
  dirs.push({ dir: coderHome('flows'), scope: 'global' });
  return dirs;
}

/** Every discoverable flow, nearest-wins deduped by name; built-ins last. */
export function discoverFlows(cwd: string): DiscoveredFlow[] {
  const seen = new Set<string>();
  const out: DiscoveredFlow[] = [];
  for (const { dir, scope } of flowDirs(cwd)) {
    for (const flow of flowsIn(dir, scope)) {
      if (!seen.has(flow.name)) {
        seen.add(flow.name);
        out.push(flow);
      }
    }
  }
  for (const flow of flowsIn(builtinFlowsDir(), 'builtin')) {
    if (!seen.has(flow.name)) out.push(flow);
  }
  return out;
}

/** Descriptions are literal exports; importing a flow would execute it. */
export function flowDescriptions(cwd: string): string[] {
  const order = { builtin: 0, workspace: 1, global: 2 };

  return discoverFlows(cwd)
    .sort((a, b) => order[a.scope] - order[b.scope])
    .map(flow => {
      const source = fs.readFileSync(flow.path, 'utf8');
      // A minified build exports it as `x as description`.
      const alias = source
        .match(/[{,]\s*([\w$]+) as description\s*[,}]/)?.[1]
        ?.replace(/\$/g, '\\$');
      const literal = alias
        ? new RegExp(`(?:\\b(?:const|let|var)\\s+|,)${alias}\\s*=\\s*(['"\`])([\\s\\S]*?)\\1`)
        : /^export\s+const\s+description(?:\s*:\s*string)?\s*=\s*(['"`])([\s\S]*?)\1/m;
      const description = source.match(literal)?.[2]?.replace(/\s+/g, ' ').trim().slice(0, 200);

      return description ? `${flow.name}: ${description}` : flow.name;
    });
}

function isExplicitPath(ref: string): boolean {
  return ref.includes('/') || EXTS.includes(path.extname(ref));
}

/** Resolve a name or explicit path to a flow file; throws if not found. */
export function resolveFlow(
  ref: string,
  cwd: string,
): { name: string; path: string; scope?: DiscoveredFlow['scope'] } {
  if (isExplicitPath(ref)) {
    const abs = path.resolve(cwd, ref);
    if (fs.existsSync(abs)) {
      return { name: path.basename(abs, path.extname(abs)), path: abs };
    }
    throw new Error(`Flow file not found: ${ref}`);
  }
  const match = discoverFlows(cwd).find(f => f.name === ref);
  if (!match) {
    throw new Error(`No flow named "${ref}". Run \`coder flow discover\` to see available flows.`);
  }
  return { name: match.name, path: match.path, scope: match.scope };
}
