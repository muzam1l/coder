/** Flow name/path resolution. See docs/flows.md "Where flows live". */
import fs from 'node:fs';
import path from 'node:path';

import { resolveCoderHome, resolveWorkspaceRoot } from '../lib/state.js';
import type { DiscoveredFlow } from './types.js';

const EXTS = ['.ts', '.mjs', '.js'];

function flowsIn(dir: string, scope: DiscoveredFlow['scope']): DiscoveredFlow[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const found: DiscoveredFlow[] = [];
  for (const file of names.sort()) {
    const ext = path.extname(file);
    if (EXTS.includes(ext)) {
      found.push({ name: path.basename(file, ext), path: path.join(dir, file), scope });
    }
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
    dirs.push({ dir: path.join(current, '.coder', 'flows'), scope: 'workspace' });
    if (current === root || path.dirname(current) === current) {
      break;
    }
    current = path.dirname(current);
  }
  dirs.push({ dir: path.join(resolveCoderHome(), 'flows'), scope: 'global' });
  return dirs;
}

/** Every discoverable flow, nearest-wins deduped by name. */
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
  return out;
}

function isExplicitPath(ref: string): boolean {
  return ref.includes('/') || EXTS.includes(path.extname(ref));
}

/** Resolve a name or explicit path to a flow file; throws if not found. */
export function resolveFlow(ref: string, cwd: string): { name: string; path: string } {
  if (isExplicitPath(ref)) {
    const abs = path.resolve(cwd, ref);
    if (fs.existsSync(abs)) {
      return { name: path.basename(abs, path.extname(abs)), path: abs };
    }
    throw new Error(`Flow file not found: ${ref}`);
  }
  const match = discoverFlows(cwd).find(f => f.name === ref);
  if (!match) {
    throw new Error(
      `No flow named "${ref}". Run \`coder flow discover\` to see available flows.`,
    );
  }
  return { name: match.name, path: match.path };
}
