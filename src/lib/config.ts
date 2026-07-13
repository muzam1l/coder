/**
 * Coder configuration. Merge order (later wins):
 * defaults -> ~/.coder/config.json -> <workspace>/coder.config.json -> CLI flags.
 */
import fs from 'node:fs';
import { z } from 'zod';
import path from 'node:path';
import { resolveCoderHome, resolveWorkspaceRoot } from './state.js';

export interface PermissionMode {
  sandbox: 'read-only' | 'workspace-write';
  approvalPolicy: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  approvalMode: 'auto' | null;
}

export const DEFAULT_CONFIG: CoderConfig = {
  // Agents are tried in order; the next one is the fallback when the previous
  // fails to start (missing binary, auth, quota, rate limit).
  chain: ['codex', 'claude'],
  agents: {
    codex: {
      model: 'gpt-5.6-terra',
      effort: 'high',
      permissions: 'auto',
    },
    claude: {
      model: 'opus',
      effort: 'medium',
      permissions: 'auto',
    },
  },
  models: {},
  approvals: {
    escalationTimeoutMs: 120_000,
    allowedNetworkHosts: [],
  },
};

// Model aliases per agent. Values map alias -> concrete identifier.
export const CODEX_MODELS: Record<string, string> = {
  spark: 'gpt-5.3-codex-spark',
  luna: 'gpt-5.6-luna',
  terra: 'gpt-5.6-terra',
  sol: 'gpt-5.6-sol',
};
export const CODEX_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

// Native claude CLI aliases; passed through as-is.
export const CLAUDE_MODELS: Record<string, string> = {
  sonnet: 'sonnet',
  opus: 'opus',
  fable: 'fable',
};
export const CLAUDE_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

/**
 * The one permission surface, mapped per engine.
 *
 * Codex (OS-enforced sandbox + approval policy; network is denied in the
 * workspace-write sandbox, so it is escalated/refused rather than silent):
 * - read-only:       sandbox read-only,       approvals never (read-only; no writes, no network)
 * - workspace-write: sandbox workspace-write, approvals never (edits stay in the project;
 *                    sandbox escapes — out-of-workspace writes, network — are refused, not asked)
 * - auto:            sandbox workspace-write, approvals on-request; there is no command
 *                    allowlist, so every sandbox escape escalates to the caller (the
 *                    orchestrating main thread, which approves it or delegates to a human).
 *                    Hard-deny patterns and git writes are still declined outright.
 */
export const PERMISSION_MODES: Record<Permission, PermissionMode> = {
  'read-only': { sandbox: 'read-only', approvalPolicy: 'never', approvalMode: null },
  'workspace-write': { sandbox: 'workspace-write', approvalPolicy: 'never', approvalMode: null },
  // on-request: codex decides when to ask. The app-server's only plain-string
  // policies are untrusted / on-request / never (no "on-failure"; "granular"
  // needs a struct we don't model). With network + out-of-workspace writes now
  // blocked by the sandbox, escapes that codex doesn't ask about simply FAIL
  // (the agent adapts) rather than succeed silently; the ones codex does ask
  // about escalate through decideCommand to the main thread.
  // TODO(escape escalation): to make *every* sandbox escape escalate (not just
  // fail), either model the `granular` struct variant, or accept `untrusted`'s
  // friction, or drive approvals ourselves.
  auto: { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalMode: 'auto' },
};

/**
 * Claude (claude CLI print mode; unanswered permission requests are denied,
 * so every mode is deny-by-default beyond what it grants):
 * - read-only:       edit/write tools disallowed; Bash runs inside the native
 *                    OS sandbox (see claudeSandboxSettings) so reads and
 *                    inspection pipelines work while workspace writes are
 *                    blocked at the kernel level
 * - workspace-write: edits auto-accepted, everything else denied
 * - auto:            claude's own safe/unsafe judgment; unresolved asks denied
 */
export const CLAUDE_PERMISSION_FLAGS: Record<Permission, string[]> = {
  'read-only': [
    '--permission-mode',
    'dontAsk',
    '--disallowedTools',
    'Edit',
    'Write',
    'NotebookEdit',
  ],
  'workspace-write': ['--permission-mode', 'acceptEdits'],
  auto: ['--permission-mode', 'auto'],
};

// Matches claude's startup error when the OS sandbox cannot initialise (its
// message names the escape hatch, e.g. "Set sandbox.failIfUnavailable=false").
// Read-only relies on the sandbox, so this failure is distinct from a normal
// agent-startup failure: it means the mode cannot be honoured here, not that a
// different engine should take over.
export const CLAUDE_SANDBOX_UNAVAILABLE_PATTERN =
  /failIfUnavailable|sandbox\b[^.\n]*?(?:failed|could ?n[o']t|cannot|unavailable|not available|not supported)/i;

/**
 * Read-only Bash is enforced by Claude Code's native OS sandbox (Seatbelt on
 * macOS, bubblewrap + socat on Linux/WSL2) rather than a command allowlist: the
 * workspace is denied writes at the kernel level while every read/inspection
 * command (pipes, awk, jq, loops) runs unrestricted. failIfUnavailable makes
 * the turn error instead of silently downgrading to read-write when the sandbox
 * cannot start. Returns a JSON string for `claude --settings`, or null for
 * modes that need no sandbox.
 */
export function claudeSandboxSettings(permissions: Permission, cwd: string): string | null {
  if (permissions !== 'read-only') {
    return null;
  }
  return JSON.stringify({
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      filesystem: { denyWrite: [cwd] },
    },
  });
}

/**
 * Strict schema for a config object (a file's contents or the merged result).
 * Unknown keys and out-of-range values are errors, not warnings. These schemas
 * are the source of truth for the config domain types (types.ts re-exports the
 * z.infer'd types).
 */
const agentSchema = z.enum(['codex', 'claude']);
const effortSchema = z.enum(['low', 'medium', 'high']);
const permissionSchema = z.enum(['read-only', 'workspace-write', 'auto']);
const agentEntrySchema = z
  .strictObject({
    model: z.string().min(1),
    effort: effortSchema,
    permissions: permissionSchema,
  })
  .partial();
const customModelSchema = z.strictObject({
  baseUrl: z.string().url(),
  model: z.string().min(1),
  envKey: z.string().min(1).optional(),
  // 'chat' (the default) is translated for codex through the built-in
  // responses->chat bridge; 'responses' passes straight through. setup-model
  // detects this automatically; the field remains as a manual override.
  wireApi: z.enum(['chat', 'responses']).optional(),
});
const approvalsSchema = z.strictObject({
  escalationTimeoutMs: z.number().positive(),
  allowedNetworkHosts: z.array(z.string()),
});
/** The merged, effective shape (everything present after DEFAULT_CONFIG). */
const effectiveConfigSchema = z.strictObject({
  chain: z.array(agentSchema).min(1),
  agents: z.strictObject({ codex: agentEntrySchema, claude: agentEntrySchema }).partial(),
  models: z
    .record(z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase kebab-case'), customModelSchema)
    .optional(),
  approvals: approvalsSchema,
});
/** What a single config file may contain: any strict subset. */
const configSchema = effectiveConfigSchema
  .extend({ approvals: approvalsSchema.partial() })
  .partial();

export type Agent = z.infer<typeof agentSchema>;
export type Effort = z.infer<typeof effortSchema>;
export type Permission = z.infer<typeof permissionSchema>;
export type AgentConfig = z.infer<typeof agentEntrySchema>;
export type CustomModelConfig = z.infer<typeof customModelSchema>;
export type ApprovalsConfig = z.infer<typeof approvalsSchema>;
export type CoderConfig = z.infer<typeof effectiveConfigSchema>;

/** Returns human-readable errors; empty array means valid. */
export function validateConfig(candidate: unknown): string[] {
  const result = configSchema.safeParse(candidate);
  if (result.success) {
    return [];
  }
  return result.error.issues.map(issue => {
    const where = issue.path.join('.') || 'config';
    return `${where}: ${issue.message}`;
  });
}

function readJsonIfExists(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`);
  }
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return (override ?? base) as T;
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  const baseRecord = base as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      baseRecord?.[key] &&
      typeof baseRecord[key] === 'object'
    ) {
      result[key] = deepMerge(baseRecord[key], value);
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

export function resolveUserConfigFile(): string {
  return path.join(resolveCoderHome(), 'config.json');
}

export function loadConfig(cwd: string): CoderConfig {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let config: CoderConfig = DEFAULT_CONFIG;
  for (const filePath of [resolveUserConfigFile(), path.join(workspaceRoot, 'coder.config.json')]) {
    const override = readJsonIfExists(filePath);
    if (!override) {
      continue;
    }
    const errors = validateConfig(override);
    if (errors.length) {
      throw new Error(`Invalid config in ${filePath}:\n  ${errors.join('\n  ')}`);
    }
    config = deepMerge(config, override);
  }
  return config;
}

/**
 * Users paste full endpoint URLs as often as API bases; accept both by
 * stripping a trailing route segment (and trailing slashes) off the base URL.
 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/(chat\/completions|completions|responses)$/, '');
}

/** Codex-engine overrides for one custom model: model id, provider id, config. */
export interface CustomModelResolution {
  model: string;
  modelProvider: string;
  configOverrides: Record<string, unknown>;
}

/**
 * Resolve a custom (user-configured, OpenAI-compatible) model alias to codex
 * engine overrides, or null when the alias is not a custom model. The provider
 * is injected per-thread via app-server config overrides, so the user's
 * ~/.codex/config.toml is never touched.
 */
export function resolveCustomModel(
  config: CoderConfig,
  alias?: string | null,
  // When the entry speaks chat completions, codex talks to the local
  // responses->chat bridge instead of the endpoint; the bridge injects the API
  // key itself, so no env_key is configured on the provider.
  bridge?: { url: string },
): CustomModelResolution | null {
  const entry = alias ? config.models?.[alias] : undefined;
  if (!alias || !entry) {
    return null;
  }
  const providerId = `coder-${alias}`;
  return {
    model: entry.model,
    modelProvider: providerId,
    configOverrides: {
      [`model_providers.${providerId}`]: {
        name: alias,
        base_url: bridge?.url ?? normalizeBaseUrl(entry.baseUrl),
        ...(entry.envKey && !bridge ? { env_key: entry.envKey } : {}),
        // codex itself always speaks the Responses API (>= 0.144 dropped
        // 'chat'); chat-only endpoints are translated by the bridge.
        wire_api: 'responses',
      },
    },
  };
}

export function resolveCodexModel(alias?: string | null): string | null {
  if (!alias) {
    return null;
  }
  return CODEX_MODELS[alias] ?? alias;
}

/**
 * Parse a "<agent>:<model?>:<effort?>"-style spec, e.g. "codex", "codex:spark",
 * "codex:sol:high", "claude:opus:high", "terra:high" (agent inferred).
 */
export function parseAgentSpec(
  spec: string | null | undefined,
  config: CoderConfig,
): { agent: Agent; model: string | null; effort: Effort | null } | null {
  if (!spec) {
    return null;
  }
  const parts = String(spec)
    .split(':')
    .map(part => part.trim())
    .filter(Boolean);
  let agent: Agent | null = null;
  let model: string | null = null;
  let effort: Effort | null = null;

  const isEffort = (value: string): value is Effort =>
    CODEX_EFFORTS.has(value) || CLAUDE_EFFORTS.has(value);

  for (const part of parts) {
    if (part === 'codex' || part === 'claude') {
      agent = part;
    } else if (isEffort(part) && !effort) {
      effort = part;
    } else if (!model) {
      model = part;
    }
  }

  if (!agent) {
    if (model && model in CLAUDE_MODELS) {
      agent = 'claude';
    } else {
      agent = 'codex';
    }
  }

  const defaults = config.agents[agent] ?? {};
  return {
    agent,
    model: model ?? defaults.model ?? null,
    effort: effort ?? defaults.effort ?? null,
  };
}

export function writeUserConfig(config: CoderConfig): string {
  const filePath = resolveUserConfigFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return filePath;
}
