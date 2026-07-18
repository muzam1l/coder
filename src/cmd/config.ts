import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import * as z from 'zod/mini';

import { baseOptions, flag, parseArgs } from '../lib/args.js';
import { resolveWorkspaceRoot } from '../lib/state.js';
import { loadConfig, resolveUserConfigFile, validateConfig } from '../lib/config.js';
import { fail, outStyle, printJson, resolveCwd } from '../lib/ui.js';
import type { AgentConfig } from '../lib/types.js';

// coder config                      -> print effective config
// coder config get <key>            -> print one value (dotted path)
// coder config set <key> <value>    -> write to ~/.coder/config.json
// coder config unset <key>          -> remove an override
// --workspace targets <repo>/coder.config.json instead of the user file.
export async function commandConfig(argv: string[]) {
  const { options, positionals } = parseArgs(argv, z.object({ ...baseOptions, workspace: flag }));
  const cwd = resolveCwd(options);
  const [action = 'list', key, ...valueParts] = positionals;
  const targetFile = options.workspace
    ? path.join(resolveWorkspaceRoot(cwd), 'coder.config.json')
    : resolveUserConfigFile();

  const getPath = (object: unknown, dotted: string): unknown =>
    dotted
      .split('.')
      .reduce<unknown>(
        (node, part) =>
          node == null ? undefined : (node as Record<string, unknown>)[part],
        object,
      );

  if (action === 'list') {
    const cfg = loadConfig(cwd);
    if (options.json) {
      printJson(cfg);
      return;
    }
    const s = outStyle;
    const summary = (agent?: AgentConfig) =>
      [agent?.model, agent?.effort, agent?.permissions].filter(Boolean).join('/') || '-';
    process.stdout.write(
      [
        `${s.dim('chain')}      ${cfg.chain.join(' -> ')}`,
        `${s.dim('codex')}      ${summary(cfg.agents.codex)}`,
        `${s.dim('claude')}     ${summary(cfg.agents.claude)}`,
        `${s.dim('approvals')}  timeout=${cfg.approvals.escalationTimeoutMs}ms  hosts=[${cfg.approvals.allowedNetworkHosts.join(', ')}]`,
        `${s.dim('file')}       ${resolveUserConfigFile()}`,
      ].join('\n') + '\n',
    );
    return;
  }
  if (action === 'get') {
    if (!key) {
      fail('Usage: coder config get <key>  (e.g. chain, agents.codex.model)');
    }
    const value = getPath(loadConfig(cwd), key);
    if (options.json || value === null || (typeof value === 'object' && value !== undefined)) {
      printJson(value === undefined ? null : value);
      return;
    }
    process.stdout.write(`${value === undefined ? '(unset)' : String(value)}\n`);
    return;
  }
  if (action !== 'set' && action !== 'unset') {
    fail('Usage: coder config [get|set|unset] <key> [value] [--workspace]');
  }
  if (!key || (action === 'set' && valueParts.length === 0)) {
    fail(`Usage: coder config ${action} <key>${action === 'set' ? ' <value>' : ''}`);
  }

  const raw = valueParts.join(' ');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    // Not JSON: comma lists become arrays ("codex,claude"), rest stay strings.
    value = raw.includes(',')
      ? raw
          .split(',')
          .map(part => part.trim())
          .filter(Boolean)
      : raw;
  }

  const current: Record<string, any> = fs.existsSync(targetFile)
    ? JSON.parse(fs.readFileSync(targetFile, 'utf8'))
    : {};
  const parts = key.split('.');
  const leaf = parts.at(-1)!;
  let node: Record<string, any> = current;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) {
      node[part] = {};
    }
    node = node[part];
  }
  if (action === 'set') {
    node[leaf] = value;
  } else {
    delete node[leaf];
  }
  const errors = validateConfig(current);
  if (errors.length) {
    fail(`Refusing to write invalid config:\n  ${errors.join('\n  ')}`);
  }
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8');

  const effective = getPath(loadConfig(cwd), key) ?? null;
  if (options.json) {
    printJson({
      file: targetFile,
      key,
      ...(action === 'set' ? { value } : { unset: true }),
      effective,
    });
    return;
  }
  const s = outStyle;
  const detail =
    action === 'set'
      ? `${s.cyan(key)} = ${JSON.stringify(value)}`
      : `unset ${s.cyan(key)}`;
  process.stdout.write(`${detail}  ${s.dim(`(${targetFile})`)}\n`);
}
