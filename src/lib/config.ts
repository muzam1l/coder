/**
 * Coder configuration. Merge order (later wins):
 * defaults -> ~/.coder/config.json -> <workspace>/coder.config.json -> CLI flags.
 */
import fs from 'node:fs';
import * as z from 'zod/mini';
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
// Engines are what execute a turn; agents are what you dispatch and chain:
// the two engines plus "custom", the grouping of the user's configured
// (OpenAI-compatible) models. Underneath, custom runs on the codex engine.
const engineSchema = z.enum(['codex', 'claude']);
const agentSchema = z.enum(['codex', 'claude', 'custom']);
const effortSchema = z.enum(['low', 'medium', 'high']);
const permissionSchema = z.enum(['read-only', 'workspace-write', 'auto']);
const agentEntrySchema = z.partial(
  z.strictObject({
    model: z.string().check(z.minLength(1)),
    effort: effortSchema,
    permissions: permissionSchema,
  }),
);
// One `models` entry, discriminated by shape:
// - baseUrl present  -> a custom OpenAI-compatible endpoint (the custom agent)
// - provider present -> an alias onto a built-in engine (codex/claude)
// - neither          -> a bare toggle for a built-in name ({ "disabled": true })
const customModelSchema = z.strictObject({
  baseUrl: z.url(),
  model: z.string().check(z.minLength(1)),
  envKey: z.optional(z.string().check(z.minLength(1))),
  // 'chat' (the default) is translated for codex through the built-in
  // responses->chat bridge; 'responses' passes straight through. `coder model`
  // detects this automatically; the field remains as a manual override.
  wireApi: z.optional(z.enum(['chat', 'responses'])),
  disabled: z.optional(z.boolean()),
});
const aliasModelSchema = z.strictObject({
  provider: engineSchema,
  model: z.string().check(z.minLength(1)),
  effort: z.optional(effortSchema),
  disabled: z.optional(z.boolean()),
});
const toggleModelSchema = z.strictObject({
  disabled: z.boolean(),
});
const modelEntrySchema = z.union([customModelSchema, aliasModelSchema, toggleModelSchema]);
const approvalsSchema = z.strictObject({
  escalationTimeoutMs: z.number().check(z.positive()),
  allowedNetworkHosts: z.array(z.string()),
});
/** The merged, effective shape (everything present after DEFAULT_CONFIG). */
const effectiveConfigSchema = z.strictObject({
  chain: z.array(agentSchema).check(z.minLength(1)),
  agents: z.partial(
    z.strictObject({ codex: agentEntrySchema, claude: agentEntrySchema, custom: agentEntrySchema }),
  ),
  // The one model namespace: custom endpoints, engine aliases, and built-in
  // disable toggles all live here, keyed by the name used at dispatch. A user
  // entry named after a built-in alias shadows it.
  // Keys are permissive enough for raw engine slugs (dots, slashes: a bare
  // toggle may target e.g. "gpt-5.6-terra"); `coder model add`/`alias` keep
  // their own stricter kebab-case rule for names they mint.
  models: z.optional(
    z.record(z.string().check(z.regex(/^[a-z0-9][a-z0-9./_-]*$/i, 'model name')), modelEntrySchema),
  ),
  approvals: approvalsSchema,
});
/** What a single config file may contain: any strict subset. */
const configSchema = z.partial(z.extend(effectiveConfigSchema, { approvals: z.partial(approvalsSchema) }));

export type Engine = z.infer<typeof engineSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type Effort = z.infer<typeof effortSchema>;
export type Permission = z.infer<typeof permissionSchema>;
export type AgentConfig = z.infer<typeof agentEntrySchema>;
export type CustomModelConfig = z.infer<typeof customModelSchema>;
export type AliasModelConfig = z.infer<typeof aliasModelSchema>;
export type ModelEntry = z.infer<typeof modelEntrySchema>;

/** A custom OpenAI-compatible endpoint entry. */
export function isEndpointModel(entry: ModelEntry): entry is CustomModelConfig {
  return 'baseUrl' in entry;
}

/** An alias entry onto a built-in engine. */
export function isAliasModel(entry: ModelEntry): entry is AliasModelConfig {
  return 'provider' in entry;
}
export type ApprovalsConfig = z.infer<typeof approvalsSchema>;
export type CoderConfig = z.infer<typeof effectiveConfigSchema>;

/** Returns human-readable errors; empty array means valid. */
export function validateConfig(candidate: unknown): string[] {
  const result = configSchema.safeParse(candidate);
  if (!result.success) {
    return result.error.issues.map(issue => {
      const where = issue.path.join('.') || 'config';
      return `${where}: ${issue.message}`;
    });
  }
  const config = deepMerge(DEFAULT_CONFIG, result.data);
  const errors: string[] = [];
  for (const [name, entry] of Object.entries(result.data.models ?? {})) {
    if (name === 'codex' || name === 'claude' || name === 'custom') {
      errors.push(`models.${name}: reserved agent name`);
      continue;
    }
    if (isAliasModel(entry)) {
      // Alias expansion is one level: the target must be an engine model id or
      // built-in alias, never another config entry.
      const target = config.models?.[entry.model];
      if (target && !isEndpointModel(target)) {
        errors.push(`models.${name}: alias target "${entry.model}" is itself a config entry`);
      }
    }
    // A bare { "disabled" } toggle is valid on any name: built-ins, entries
    // defined in another config layer (the per-entry merge folds the flag in),
    // or raw model slugs passed straight to an engine.
  }
  return errors;
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
  const errors = validateConfig(config);
  if (errors.length) {
    throw new Error(`Invalid merged config:\n  ${errors.join('\n  ')}`);
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

/**
 * Persist a patch onto an existing custom-model entry, in whichever config
 * file defines it (workspace first — it wins the merge). Used to save back a
 * runtime wire-api detection for hand-written entries so later turns skip the
 * probe. A no-op when no file defines the entry, or the patch would make the
 * file invalid.
 */
export function persistModelPatch(
  cwd: string,
  alias: string,
  patch: Partial<CustomModelConfig>,
): boolean {
  const files = [
    path.join(resolveWorkspaceRoot(cwd), 'coder.config.json'),
    resolveUserConfigFile(),
  ];
  for (const filePath of files) {
    let raw: any;
    try {
      raw = readJsonIfExists(filePath);
    } catch {
      continue;
    }
    if (!raw?.models?.[alias]) {
      continue;
    }
    Object.assign(raw.models[alias], patch);
    if (validateConfig(raw).length) {
      return false;
    }
    fs.writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    return true;
  }
  return false;
}

/** Did the user paste a full endpoint URL rather than an API base? */
export function hasExplicitEndpoint(baseUrl: string): boolean {
  return /\/(chat\/completions|completions|responses)\/*$/.test(baseUrl);
}

/**
 * Candidate URLs for an API route, most-likely first. A bare host (e.g.
 * `https://ai-gateway.vercel.sh`) usually serves the API under /v1, so we try
 * `<base>/<route>` then `<base>/v1/<route>`. When the user supplied a full
 * endpoint path, or the base already names a version segment, there is exactly
 * one candidate — a failure there is theirs to fix, not ours to guess around.
 */
export function endpointCandidates(baseUrl: string, route: string): string[] {
  const base = normalizeBaseUrl(baseUrl);
  if (hasExplicitEndpoint(baseUrl) || /\/v\d+(alpha|beta)?$/.test(base)) {
    return [`${base}/${route}`];
  }
  return [`${base}/${route}`, `${base}/v1/${route}`];
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
  if (!alias || !entry || !isEndpointModel(entry)) {
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

/** A built-in alias name (codex or claude), independent of config state. */
export function isBuiltinAlias(name: string): boolean {
  return name in CODEX_MODELS || name in CLAUDE_MODELS;
}

/** Disabled via its entry's `disabled` flag (any entry kind, incl. toggles). */
export function isModelDisabled(config: CoderConfig, name?: string | null): boolean {
  return Boolean(name && config.models?.[name]?.disabled);
}

/**
 * Throw a clear error when a disabled model is requested. Enforced by every
 * model-resolution path so a disabled model cannot reach an engine.
 */
export function assertModelEnabled(config: CoderConfig, name?: string | null): void {
  if (isModelDisabled(config, name)) {
    throw new Error(`model "${name}" is disabled in config`);
  }
}

/**
 * Parse a "<agent>:<model?>:<effort?>"-style spec, e.g. "codex", "codex:spark",
 * "codex:sol:high", "claude:opus:high", "terra:high" (agent inferred).
 *
 * A user alias entry (config.models with `provider`) named by the model part
 * is expanded one level; alias targets are never themselves entries (enforced
 * at save time), so no recursion is possible. Throws when the resolved model
 * is disabled in config.
 */
export function parseAgentSpec(
  spec: string | null | undefined,
  config: CoderConfig,
): { agent: Agent; model: string | null; effort: Effort | null } | null {
  if (!spec) {
    return null;
  }
  const raw = String(spec).trim();
  const parts = raw.split(':').map(part => part.trim());
  if (!parts.length || parts.length > 3 || parts.some(part => !part)) {
    throw new Error(`Invalid agent spec "${spec}".`);
  }
  let agent: Agent | null = null;
  let model: string | null = null;
  let effort: Effort | null = null;

  const isEffort = (value: string): value is Effort =>
    CODEX_EFFORTS.has(value) || CLAUDE_EFFORTS.has(value);

  for (const part of parts) {
    if (part === 'codex' || part === 'claude' || part === 'custom') {
      if (agent) {
        throw new Error(`Invalid agent spec "${spec}".`);
      }
      agent = part;
    } else if (isEffort(part) && !effort) {
      effort = part;
    } else if (!model) {
      model = part;
    } else {
      throw new Error(`Invalid agent spec "${spec}".`);
    }
  }

  // One-level alias expansion: the model part names an alias entry. Its
  // targets are never entries themselves (enforced at save/validate time).
  const entry = model ? config.models?.[model] : undefined;
  if (entry && isAliasModel(entry)) {
    if (entry.disabled) {
      throw new Error(`model "${model}" is disabled in config`);
    }
    if (agent && agent !== entry.provider) {
      throw new Error(`Alias "${model}" runs on ${entry.provider}, not ${agent}.`);
    }
    agent = entry.provider;
    effort = effort ?? entry.effort ?? null;
    model = entry.model;
  }

  if (!agent) {
    if (model && model in CLAUDE_MODELS) {
      agent = 'claude';
    } else if (model && entry && isEndpointModel(entry)) {
      agent = 'custom';
    } else {
      agent = 'codex';
    }
  }

  const defaults = config.agents[agent] ?? {};
  const resolvedModel = model ?? defaults.model ?? null;
  assertModelEnabled(config, resolvedModel);
  return {
    agent,
    model: resolvedModel,
    effort: effort ?? defaults.effort ?? null,
  };
}

export function writeUserConfig(config: CoderConfig): string {
  const filePath = resolveUserConfigFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return filePath;
}
