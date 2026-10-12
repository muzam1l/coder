import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig, type McpConfigEntry } from './config';
import { coderHome } from './state';
import type { McpServerSpec } from './types';
import { writeJsonFileAtomic } from '../utils/fsx';

export function markRepositoryMcp(
  entries: Record<string, McpConfigEntry> | undefined,
  repository: boolean,
) {
  for (const entry of Object.values(entries ?? {}))
    Object.defineProperty(entry, 'repository', { value: repository, configurable: true });
}

export function mcpApprovalHash(entry: McpConfigEntry | McpServerSpec): string {
  const shape = {
    ...(entry.url ? { url: entry.url } : { command: entry.command, args: entry.args ?? [] }),
    headers: Object.keys(entry.headers ?? {}).sort(),
    env: Object.keys(entry.env ?? {}).sort(),
  };

  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

function approvals(): Record<string, true> {
  try {
    const value = JSON.parse(
      fs.readFileSync(coderHome('state', 'global', 'mcp-approvals.json'), 'utf8'),
    );
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError)
      return {};
    throw error;
  }
}

export function mcpApproved(entry: McpConfigEntry | McpServerSpec): boolean {
  return approvals()[mcpApprovalHash(entry)] === true;
}

export async function mcpApprove(cwd: string, name: string | undefined, agentId?: string) {
  if (!name) throw new Error('Usage: coder connection approve <name> [--agent <id>]');
  const configured = loadConfig(cwd).mcp?.[name];
  const candidates: McpConfigEntry[] = [];
  if (configured && !agentId) candidates.push(configured);
  const { loadAgents } = await import('../agent/load');
  const { INTEGRATIONS } = await import('../integrations');
  for (const agent of await loadAgents(cwd, INTEGRATIONS, { includeDisabled: true })) {
    const entry = agent.definition.mcp?.[name];
    if (entry && (!agentId || agent.id === agentId)) candidates.push(entry);
  }
  if (!candidates.length)
    throw new Error(`No MCP server "${name}". Use --cwd to select its repository.`);
  if (candidates.some(entry => entry.connection))
    throw new Error(`MCP server "${name}" uses a connection and needs no repository approval.`);
  const hashes = new Set(candidates.map(mcpApprovalHash));
  if (hashes.size !== 1)
    throw new Error(
      `MCP server "${name}" has different definitions. Select one with --agent <id>.`,
    );

  const file = coderHome('state', 'global', 'mcp-approvals.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const store = approvals();
  store[[...hashes][0]!] = true;
  writeJsonFileAtomic(file, store);
  fs.chmodSync(file, 0o600);

  return { name, file };
}

export function mcpSecretValue(value: string): boolean {
  return (
    !/\$\{[^}]+\}/.test(value) &&
    (/^(?:Bearer\s+\S+|ghp_|github_pat_|xox[a-z]-|sk-|lin_api_)/i.test(value) ||
      /^[A-Za-z0-9_+\/.=-]{32,}$/.test(value))
  );
}

export function mcpWarnings(name: string, entry: unknown): string[] {
  if (!entry || typeof entry !== 'object') return [];
  const { url, headers, env } = entry as Record<string, unknown>;
  const strings = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value).filter(
          (pair): pair is [string, string] => typeof pair[1] === 'string',
        )
      : [];
  const warnings: string[] = [];
  if (
    typeof url === 'string' &&
    [url, ...strings(headers).map(([, value]) => value)].some(value => /\$\{[^}]+\}/.test(value))
  )
    warnings.push(
      `MCP server "${name}" keeps remote URL and header variables literal. Use a connection for credentials.`,
    );
  for (const [field, record] of [
    ['headers', headers],
    ['env', env],
  ] as const) {
    for (const [key, value] of strings(record)) {
      if (mcpSecretValue(value))
        warnings.push(
          `MCP server "${name}" has a literal secret in ${field}.${key}. Use a connection instead.`,
        );
    }
  }

  return warnings;
}
