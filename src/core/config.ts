/**
 * Coder configuration. Merge order (later wins):
 * defaults -> ~/.coder/config.json -> <workspace>/coder.config.json -> CLI flags.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import * as z from 'zod/mini';

import { DEFAULT_CONFIG } from './defaults';
import { coderHome, resolveWorkspaceRoot } from './state';

export { DEFAULT_CONFIG };

export interface PermissionMode {
  sandbox: 'read-only' | 'workspace-write';
  approvalPolicy: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  approvalMode: 'auto' | null;
}

// Model aliases per engine. Values map alias -> concrete identifier.
export const CODEX_MODELS: Record<string, string> = {
  luna: 'gpt-6-luna',
  sol: 'gpt-6.1-sol',
  astra: 'gpt-6-astra',
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
 *                    sandbox escapes such as out-of-workspace writes and network are refused, not asked)
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
  // (the engine adapts) rather than succeed silently; the ones codex does ask
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
 *                    OS sandbox (see claudeTurnSettings) so reads and
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

/**
 * Sidecars (`task ask`, approval review) answer ABOUT a task from its on-disk
 * state, so their reach is narrower than a read-only task turn: the caller's
 * --allowedTools plus an --add-dir scope, nothing else. Bash is denied outright
 * rather than left to the sandbox. --allowedTools only *grants*. It never
 * restricts), and the sandbox denies writes, not reads, so an
 * autoAllowBashIfSandboxed Bash would read the whole machine. WebFetch/
 * WebSearch/Task go too: a question about a task is answered from disk.
 */
export const CLAUDE_SIDECAR_FLAGS: string[] = [
  '--permission-mode',
  'dontAsk',
  '--disallowedTools',
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash',
  'WebFetch',
  'WebSearch',
  'Task',
];

// Matches claude's startup error when the OS sandbox cannot initialise (its
// message names the escape hatch, e.g. "Set sandbox.failIfUnavailable=false").
// Read-only relies on the sandbox, so this failure is distinct from a normal
// engine-startup failure: it means the mode cannot be honoured here, not that a
// different engine should take over.
export const CLAUDE_SANDBOX_UNAVAILABLE_PATTERN =
  /failIfUnavailable|sandbox\b[^.\n]*?(?:failed|could ?n[o']t|cannot|unavailable|not available|not supported)/i;

// approvals.allowedNetworkHosts entries as claude sandbox allowedDomains:
// a bare hostname also covers its subdomains (matching the codex policy's
// endsWith check), bare IPv6 gets bracket form, IPs / host:port / already
// bracketed entries pass through as-is.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function claudeAllowedDomains(hosts: string[]): string[] {
  return hosts.flatMap(host => {
    if (net.isIPv6(host)) return [`[${host}]`];
    if (host.startsWith('[') || host.includes(':') || net.isIP(host)) return [host];
    return [host, `*.${host}`];
  });
}

/**
 * Read-only Bash is enforced by Claude Code's native OS sandbox (Seatbelt on
 * macOS, bubblewrap + socat on Linux/WSL2) rather than a command allowlist: the
 * workspace is denied writes at the kernel level while every read/inspection
 * command (pipes, awk, jq, loops) runs unrestricted. failIfUnavailable makes
 * the turn error instead of silently downgrading to read-write when the sandbox
 * cannot start. Returns a JSON string for `claude --settings`, or null for
 * modes that need no sandbox.
 *
 * Extra directories are sent twice on purpose: as
 * permissions.additionalDirectories here and as --add-dir flags. They are the
 * two documented forms of the same grant, and a working directory the CLI does
 * not register is a hard read denial ("Path is outside allowed working
 * directories"), so it is worth not depending on one of them. Read-only also
 * denies writes there; other modes let them follow the mode like cwd.
 *
 * Writable directories stay writable in every mode: read-only grants them
 * through sandbox.filesystem.allowWrite alone, the other modes as extra directories.
 */
export function claudeTurnSettings(
  permissions: Permission,
  cwd: string,
  allowedNetworkHosts: string[] = [],
  additionalDirectories: string[] = [],
  writableDirectories: string[] = [],
): string | null {
  const granted =
    permissions === 'read-only'
      ? additionalDirectories
      : [...additionalDirectories, ...writableDirectories];
  const grant = granted.length ? { permissions: { additionalDirectories: granted } } : {};
  if (permissions === 'read-only') {
    return JSON.stringify({
      ...grant,
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        filesystem: {
          denyWrite: [cwd, ...additionalDirectories],
          ...(writableDirectories.length ? { allowWrite: writableDirectories } : {}),
        },
      },
    });
  }
  // auto/workspace-write: sandboxed commands skip the permission prompt; only
  // escapes hit the permission layer, which alone still gates safely.
  // In auto mode, approvals.allowedNetworkHosts are reachable inside the
  // sandbox with no escape or ask. The same hosts the Codex approval policy.
  // auto-accepts network escalations for.
  return JSON.stringify({
    ...grant,
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      ...(permissions === 'auto' && allowedNetworkHosts.length
        ? {
            network: {
              allowedDomains: claudeAllowedDomains(allowedNetworkHosts),
              // An allowlisted loopback host also lets commands serve on it (macOS only), so a local dev server runs sandboxed.
              ...(allowedNetworkHosts.some(host => LOOPBACK_HOSTS.has(host))
                ? { allowLocalBinding: true }
                : {}),
            },
          }
        : {}),
    },
  });
}

/**
 * Strict schema for a config object (a file's contents or the merged result).
 * Unknown keys and out-of-range values are errors, not warnings. These schemas
 * are the source of truth for the config domain types (types.ts re-exports the
 * z.infer'd types).
 */
// Providers run a turn; engines are what you dispatch and chain: the two
// providers plus "custom", the user's OpenAI-compatible models on codex.
const providerSchema = z.enum(['codex', 'claude']);
const engineSchema = z.enum(['codex', 'claude', 'custom']);
const effortSchema = z.enum(['low', 'medium', 'high']);
const permissionSchema = z.enum(['read-only', 'workspace-write', 'auto']);
const engineEntrySchema = z.partial(
  z.strictObject({
    model: z.string().check(z.minLength(1)),
    effort: effortSchema,
    permissions: permissionSchema,
  }),
);
// Codex alone exposes network access as its own switch; it defaults to the
// permission mode (`auto` allows the network, the stricter modes deny it).
const codexEngineEntrySchema = z.partial(
  z.strictObject({
    model: z.string().check(z.minLength(1)),
    effort: effortSchema,
    permissions: permissionSchema,
    network: z.boolean(),
  }),
);
// One `models` entry, discriminated by shape:
// - baseUrl present  -> a custom OpenAI-compatible endpoint (the custom engine)
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
  provider: providerSchema,
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
const agentPresetSchema = z.enum(['observe', 'comment', 'write']);
// Agent and flow names reach shell commands inside runners, so keep them to safe slugs.
const agentNameSchema = z.string().check(z.regex(/^[a-z0-9][a-z0-9_-]*$/i, 'agent or flow name'));
// `agents` holds usage only: how this repo runs an agent. What an agent IS lives in
// `.coder/agents/<id>/agent.json` (see src/agent/definition.ts).
const agentUsageIntegrationSchema = z.strictObject({
  allowedTools: z.optional(z.union([agentPresetSchema, z.array(z.string())])),
  allowedEvents: z.optional(z.array(z.string())),
});
const agentUsageSchema = z.union([
  z.boolean(),
  z.strictObject({
    engine: z.optional(z.string()),
    model: z.optional(z.string()),
    effort: z.optional(effortSchema),
    permissions: z.optional(permissionSchema),
    runner: z.optional(z.enum(['local', 'local-docker', 'vercel-sandbox', 'github-actions'])),
    integrations: z.optional(z.record(z.string(), agentUsageIntegrationSchema)),
  }),
]);
/** The merged, effective shape (everything present after DEFAULT_CONFIG). */
export const mcpEntrySchema = z
  .strictObject({
    command: z.optional(z.string().check(z.minLength(1))),
    args: z.optional(z.array(z.string())),
    env: z.optional(z.record(z.string(), z.string())),
    url: z.optional(z.string().check(z.minLength(1))),
    type: z.optional(z.enum(['stdio', 'http', 'sse'])),
    headers: z.optional(z.record(z.string(), z.string())),
    tools: z.optional(z.array(z.string())),
    description: z.optional(z.string()),
  })
  .check(z.refine(entry => Boolean(entry.command) !== Boolean(entry.url), 'one of command or url'));
const effectiveConfigSchema = z.strictObject({
  chain: z.array(engineSchema).check(z.minLength(1)),
  engines: z.partial(
    z.strictObject({
      codex: codexEngineEntrySchema,
      claude: engineEntrySchema,
      custom: engineEntrySchema,
    }),
  ),
  // The one model namespace: custom endpoints, engine aliases, and built-in
  // disable toggles all live here, keyed by the name used at dispatch. A user
  // entry named after a built-in alias shadows it.
  // Keys are permissive enough for raw engine slugs (dots, slashes: a bare
  // toggle may target e.g. "gpt-6.1-sol"); `coder model add`/`alias` keep
  // their own stricter kebab-case rule for names they mint.
  models: z.optional(
    z.record(z.string().check(z.regex(/^[a-z0-9][a-z0-9./_-]*$/i, 'model name')), modelEntrySchema),
  ),
  agents: z.optional(z.record(agentNameSchema, agentUsageSchema)),
  // MCP servers tasks may attach by name (`--mcp docs,sentry` or `--mcp all`); `.mcp.json` shape plus `tools`.
  mcp: z.optional(z.record(agentNameSchema, mcpEntrySchema)),
  approvals: approvalsSchema,
});
export type McpConfigEntry = z.infer<typeof mcpEntrySchema>;
/** What a single config file may contain: any strict subset. */
const configSchema = z.partial(
  z.extend(effectiveConfigSchema, { approvals: z.partial(approvalsSchema) }),
);

export type Provider = z.infer<typeof providerSchema>;
export type Engine = z.infer<typeof engineSchema>;
export type Effort = z.infer<typeof effortSchema>;
export type Permission = z.infer<typeof permissionSchema>;
export type EngineConfig = z.infer<typeof engineEntrySchema>;
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

/** Codex network access: the explicit `engines.codex.network` override, else `auto` only. */
export function resolveCodexNetworkAccess(permissions: Permission, override?: boolean): boolean {
  return override ?? permissions === 'auto';
}

const HOST_NAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*(?::\d{1,5})?$/i;

/** A host name, IP address, or either with a port, as the engines' network policies take them. */
function isNetworkHost(host: string): boolean {
  if (net.isIP(host)) return true;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(host);
  return bracketed ? net.isIPv6(bracketed[1]!) : host.length <= 253 && HOST_NAME.test(host);
}

/** Drop a model entry and every engine default that names it. */
export function removeModel(
  config: {
    models?: Record<string, unknown>;
    engines?: Record<string, { model?: unknown } | undefined>;
  },
  name: string,
): void {
  delete config.models?.[name];
  for (const entry of Object.values(config.engines ?? {}))
    if (entry?.model === name) delete entry.model;
}

/** Returns human-readable errors; empty array means valid. */
export function validateConfig(candidate: unknown): string[] {
  const legacy = Object.keys((candidate as { agents?: object } | null)?.agents ?? {}).filter(key =>
    ['codex', 'claude', 'custom'].includes(key),
  );
  if (legacy.length)
    return legacy.map(key => `agents.${key}: engine defaults moved to engines.${key}`);
  const result = configSchema.safeParse(candidate);
  if (!result.success) {
    return result.error.issues.map(issue => {
      const where = issue.path.join('.') || 'config';
      return `${where}: ${issue.message}`;
    });
  }
  const config = deepMerge(DEFAULT_CONFIG, result.data);
  const errors: string[] = [];
  for (const [index, host] of (result.data.approvals?.allowedNetworkHosts ?? []).entries()) {
    if (!isNetworkHost(host))
      errors.push(
        `approvals.allowedNetworkHosts.${index}: "${host}" is not a host name or IP address`,
      );
  }
  for (const [name, entry] of Object.entries(result.data.models ?? {})) {
    if (name === 'codex' || name === 'claude' || name === 'custom') {
      errors.push(`models.${name}: reserved engine name`);
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

/** One config layer over the defaults, as `loadConfig` merges it. */
export function withDefaults(override: unknown): CoderConfig {
  return deepMerge(DEFAULT_CONFIG, override);
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
  return coderHome('config.json');
}

// Everything a workspace gives coder lives under .coder/; a root-level file
// from before that move is migrated in place on first read.
const LEGACY_WORKSPACE_CONFIG_FILES = ['coder.config.json', 'coder.json'];

/** `<root>/.coder/config.json`, migrating a legacy root-level config file into it once. */
export function resolveWorkspaceConfigFile(workspaceRoot: string): string {
  const filePath = path.join(workspaceRoot, '.coder', 'config.json');
  if (fs.existsSync(filePath)) return filePath;
  for (const legacy of LEGACY_WORKSPACE_CONFIG_FILES) {
    const from = path.join(workspaceRoot, legacy);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.renameSync(from, filePath);
    process.stderr.write(`coder: moved ${legacy} to .coder/config.json\n`);
    break;
  }
  return filePath;
}

/** A server task's workspace config, as JSON; the repo's config may then only narrow it. */
export const WORKSPACE_CONFIG_ENV = 'CODER_WORKSPACE_CONFIG';

/** What a repo config may change under a server workspace config: fewer engines, models, and hosts, other engine defaults. */
function narrowed(base: CoderConfig, repo: Partial<CoderConfig>): Partial<CoderConfig> {
  const hosts = repo.approvals?.allowedNetworkHosts?.filter(host =>
    base.approvals.allowedNetworkHosts.includes(host),
  );
  const engines = Object.fromEntries(
    Object.entries(repo.engines ?? {}).map(([engine, entry]) => [
      engine,
      {
        ...(entry?.model ? { model: entry.model } : {}),
        ...(entry?.effort ? { effort: entry.effort } : {}),
      },
    ]),
  );
  const disabled = Object.entries(repo.models ?? {}).filter(([, entry]) => entry.disabled === true);
  return {
    ...(repo.chain ? { chain: repo.chain.filter(engine => base.chain.includes(engine)) } : {}),
    engines,
    models: Object.fromEntries(disabled.map(([name]) => [name, { disabled: true }])),
    ...(hosts ? { approvals: { ...base.approvals, allowedNetworkHosts: hosts } } : {}),
  };
}

export function loadConfig(cwd: string): CoderConfig {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const server = process.env[WORKSPACE_CONFIG_ENV];
  const layers: Array<[string, unknown]> = [
    [resolveUserConfigFile(), readJsonIfExists(resolveUserConfigFile())],
    ...(server ? [['the workspace config', JSON.parse(server)] as [string, unknown]] : []),
  ];
  const repoFile = resolveWorkspaceConfigFile(workspaceRoot);
  layers.push([repoFile, readJsonIfExists(repoFile)]);
  let config: CoderConfig = DEFAULT_CONFIG;
  for (const [source, value] of layers) {
    if (!value) {
      continue;
    }
    const errors = validateConfig(value);
    if (errors.length) {
      throw new Error(`Invalid config in ${source}:\n  ${errors.join('\n  ')}`);
    }
    config = deepMerge(config, server && source === repoFile ? narrowed(config, value) : value);
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
 * file defines it. The workspace is first and wins the merge. Used to save a
 * runtime wire-api detection for hand-written entries so later turns skip the
 * probe. A no-op when no file defines the entry, or the patch would make the
 * file invalid.
 */
export function persistModelPatch(
  cwd: string,
  alias: string,
  patch: Partial<CustomModelConfig>,
): boolean {
  const files = [resolveWorkspaceConfigFile(resolveWorkspaceRoot(cwd)), resolveUserConfigFile()];
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
 * one candidate. A failure there is theirs to fix, not ours to guess around.
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
 * Parse a "<engine>:<model?>:<effort?>"-style spec, e.g. "codex", "codex:luna",
 * "codex:sol:high", "claude:opus:high", "astra:high" (engine inferred).
 *
 * A user alias entry (config.models with `provider`) named by the model part
 * is expanded one level; alias targets are never themselves entries (enforced
 * at save time), so no recursion is possible. Throws when the resolved model
 * is disabled in config.
 */
export function parseEngineSpec(
  spec: string | null | undefined,
  config: CoderConfig,
): { engine: Engine; model: string | null; effort: Effort | null } | null {
  if (!spec) {
    return null;
  }
  const raw = String(spec).trim();
  const parts = raw.split(':').map(part => part.trim());
  if (!parts.length || parts.length > 3 || parts.some(part => !part)) {
    throw new Error(`Invalid engine spec "${spec}".`);
  }
  let engine: Engine | null = null;
  let model: string | null = null;
  let effort: Effort | null = null;

  const isEffort = (value: string): value is Effort =>
    CODEX_EFFORTS.has(value) || CLAUDE_EFFORTS.has(value);

  for (const part of parts) {
    if (part === 'codex' || part === 'claude' || part === 'custom') {
      if (engine) {
        throw new Error(`Invalid engine spec "${spec}".`);
      }
      engine = part;
    } else if (isEffort(part) && !effort) {
      effort = part;
    } else if (!model) {
      model = part;
    } else {
      throw new Error(`Invalid engine spec "${spec}".`);
    }
  }

  // One-level alias expansion: the model part names an alias entry. Its
  // targets are never entries themselves (enforced at save/validate time).
  const entry = model ? config.models?.[model] : undefined;
  if (entry && isAliasModel(entry)) {
    if (entry.disabled) {
      throw new Error(`model "${model}" is disabled in config`);
    }
    if (engine && engine !== entry.provider) {
      throw new Error(`Alias "${model}" runs on ${entry.provider}, not ${engine}.`);
    }
    engine = entry.provider;
    effort = effort ?? entry.effort ?? null;
    model = entry.model;
  }

  if (!engine) {
    if (model && model in CLAUDE_MODELS) {
      engine = 'claude';
    } else if (model && entry && isEndpointModel(entry)) {
      engine = 'custom';
    } else {
      engine = 'codex';
    }
  }

  const defaults = config.engines[engine] ?? {};
  const resolvedModel = model ?? defaults.model ?? null;
  assertModelEnabled(config, resolvedModel);
  return {
    engine,
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

export function getPath(object: unknown, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>(
      (node, part) => (node == null ? undefined : (node as Record<string, unknown>)[part]),
      object,
    );
}

export function configTargetFile(cwd: string, workspace?: boolean): string {
  return workspace
    ? resolveWorkspaceConfigFile(resolveWorkspaceRoot(cwd))
    : resolveUserConfigFile();
}

// Print-free core: the whole effective config, or one dotted-path value
// (undefined when unset).
export function configGet(cwd: string, key?: string): unknown {
  const cfg = loadConfig(cwd);
  return key ? getPath(cfg, key) : cfg;
}

// Print-free core: set (or unset) a dotted key in the user (or --workspace)
// config file, validate, and return the effective value afterward.
export function configSet(
  cwd: string,
  key: string,
  value: unknown,
  opts: { workspace?: boolean; unset?: boolean } = {},
): { file: string; key: string; effective: unknown; value?: unknown; unset?: boolean } {
  const targetFile = configTargetFile(cwd, opts.workspace);
  writeConfigFile(targetFile, current => {
    const parts = key.split('.');
    const leaf = parts.at(-1)!;
    let node: Record<string, any> = current;
    for (const part of parts.slice(0, -1)) {
      if (typeof node[part] !== 'object' || node[part] === null) {
        node[part] = {};
      }
      node = node[part];
    }
    if (opts.unset) {
      delete node[leaf];
    } else {
      node[leaf] = value;
    }
  });
  const effective = getPath(loadConfig(cwd), key) ?? null;
  return {
    file: targetFile,
    key,
    ...(opts.unset ? { unset: true } : { value }),
    effective,
  };
}

// Mutate a config file in place: read (or start empty), apply, drop keys that
// went empty (older coder versions reject unknown/empty config keys outright),
// validate, write.
export function writeConfigFile(targetFile: string, mutate: (config: Record<string, any>) => void) {
  const current: Record<string, any> = fs.existsSync(targetFile)
    ? JSON.parse(fs.readFileSync(targetFile, 'utf8'))
    : {};
  mutate(current);
  if (current.models && Object.keys(current.models).length === 0) {
    delete current.models;
  }
  const errors = validateConfig(current);
  if (errors.length) {
    throw new Error(`Refusing to write invalid config:\n  ${errors.join('\n  ')}`);
  }
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
}

const MCP_ADD_USAGE =
  'Usage: coder mcp add <name> [--tools a,b] [--user] (--url <url> [--header K=V] | -- <command> [args...])';

/** Flags of `coder mcp add`: a remote `url` or a stdio `command`; env, header and tools are comma lists. */
export interface McpAddOptions {
  url?: string;
  transport?: string;
  header?: string;
  env?: string;
  tools?: string;
  command?: string[];
  user?: boolean;
}

// The workspace config, or the user one with `user`.
function mcpConfigFile(cwd: string, user?: boolean): string {
  return user ? resolveUserConfigFile() : resolveWorkspaceConfigFile(resolveWorkspaceRoot(cwd));
}

function pairs(value: string | undefined, flagName: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (value ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq < 1)
      throw new Error(`Invalid ${flagName} "${pair}": use KEY=VALUE (values may hold \${VAR}).`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function saveMcp(cwd: string, name: string, entry: Record<string, unknown>, user?: boolean) {
  const file = mcpConfigFile(cwd, user);
  writeConfigFile(file, current => {
    current.mcp = { ...current.mcp, [name]: entry };
  });
  return { name, file };
}

/** Print-free core of `coder mcp add`: save a stdio or remote server entry. */
export function mcpAdd(cwd: string, name: string | undefined, opts: McpAddOptions = {}) {
  const [command, ...args] = opts.command ?? [];
  if (!name) throw new Error(MCP_ADD_USAGE);
  if (!command && !opts.url) throw new Error('Give a remote --url, or a command after `--`.');
  if (command && opts.url) throw new Error('Use either --url or a command, not both.');
  const tools = opts.tools
    ? {
        tools: opts.tools
          .split(',')
          .map(s => s.trim())
          .filter(Boolean),
      }
    : {};
  const env = pairs(opts.env, '--env');
  const headers = pairs(opts.header, '--header');
  return saveMcp(
    cwd,
    name,
    opts.url
      ? {
          url: opts.url,
          ...(opts.transport ? { type: opts.transport } : {}),
          ...(Object.keys(headers).length ? { headers } : {}),
          ...tools,
        }
      : {
          command,
          ...(args.length ? { args } : {}),
          ...(Object.keys(env).length ? { env } : {}),
          ...tools,
        },
    opts.user,
  );
}

/** Print-free core of `coder mcp add-json`: save an entry from any `.mcp.json`, as JSON text or an object. */
export function mcpAddJson(
  cwd: string,
  name: string | undefined,
  json: string | Record<string, unknown> | undefined,
  opts: { user?: boolean } = {},
) {
  if (!name || !json) throw new Error("Usage: coder mcp add-json <name> '<json entry>' [--user]");
  let entry: unknown = json;
  if (typeof json === 'string') {
    try {
      entry = JSON.parse(json);
    } catch (error) {
      throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry))
    throw new Error('The entry must be a JSON object.');
  return saveMcp(cwd, name, entry as Record<string, unknown>, opts.user);
}

/** Print-free core of `coder mcp list`: the effective `mcp` map. */
export function mcpList(cwd: string): Record<string, McpConfigEntry> {
  return loadConfig(cwd).mcp ?? {};
}

/** Print-free core of `coder mcp rm`. */
export function mcpRemove(cwd: string, name: string | undefined, opts: { user?: boolean } = {}) {
  if (!name) throw new Error('Usage: coder mcp rm <name> [--user]');
  const file = mcpConfigFile(cwd, opts.user);
  writeConfigFile(file, current => {
    if (!current.mcp?.[name]) throw new Error(`No MCP server "${name}" in ${file}.`);
    delete current.mcp[name];
    if (!Object.keys(current.mcp).length) delete current.mcp;
  });
  return { name, file };
}
