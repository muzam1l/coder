/**
 * Coder configuration. Merge order (later wins):
 * defaults -> ~/.coder/config.json -> <workspace>/coder.config.json -> CLI flags.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import * as z from 'zod/mini';

import { ACCESS, type Access } from '../integrations/types';
import { COMMIT_SHA, DEFAULT_CONFIG } from './types';
import { coderHome, resolveWorkspaceRoot } from './state';
import { markRepositoryMcp } from './mcp';

export { ACCESS, DEFAULT_CONFIG, type Access };

interface AccessMode {
  sandbox: 'read-only' | 'workspace-write';
  approvalPolicy: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  approvalMode: 'auto' | null;
  approvalsReviewer: 'auto_review' | null;
}

/** Built-in aliases, each a model spec as a user's alias is; a user alias of the same name overrides one. */
export const BUILTIN_MODELS: Record<string, string> = {
  luna: 'codex/gpt-6-luna',
  sol: 'codex/gpt-6.1-sol',
  astra: 'codex/gpt-6-astra',
  sonnet: 'claude/sonnet',
  opus: 'claude/opus',
  fable: 'claude/fable',
  codex: 'codex/sol',
  claude: 'claude/opus',
};

/** The efforts a spec may end with; no model or alias takes one as its name. */
export const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

/** The effort a model runs at when its spec, or its alias, names none. */
export const DEFAULT_EFFORT = 'medium';

/**
 * The one access setting, mapped per engine.
 *
 * Codex (OS-enforced sandbox + approval policy):
 * - read-only:       sandbox read-only,       approvals never
 * - auto:            sandbox workspace-write, approvals on-request, reviewed by Codex's auto review
 *                    (`approvalsReviewer`); what it refuses the task may escalate (core/approvals).
 */
export const ACCESS_MODES: Record<Access, AccessMode> = {
  'read-only': {
    sandbox: 'read-only',
    approvalPolicy: 'never',
    approvalMode: null,
    approvalsReviewer: null,
  },
  auto: {
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalMode: 'auto',
    approvalsReviewer: 'auto_review',
  },
};

/** The hosts npm, PyPI, crates.io and Go module installs touch, open on every `auto` task. */
export const PUBLIC_REGISTRY_HOSTS = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'index.crates.io',
  'static.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
];

/**
 * Claude (claude CLI print mode):
 * - read-only:       edit/write tools disallowed; Bash runs inside the native OS sandbox
 *                    (see claudeTurnSettings), so reads work while writes are blocked
 * - auto:            Claude's own classifier reviews actions, unsandboxed retries included; what
 *                    still prompts goes to Coder's prompt tool, which denies and points at `escalate`
 */
export const CLAUDE_ACCESS_FLAGS: Record<Access, string[]> = {
  'read-only': [
    '--permission-mode',
    'dontAsk',
    '--disallowedTools',
    'Edit',
    'Write',
    'MultiEdit',
    'NotebookEdit',
  ],
  auto: ['--permission-mode', 'auto'],
};

/**
 * Sidecars (`task ask`) answer ABOUT a task from its on-disk
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
  'MultiEdit',
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

/** Set by runners that use machine isolation for writable turns. */
export const MACHINE_SANDBOX_ENV = 'CODER_MACHINE_SANDBOX';

// network.allowedHosts entries as claude sandbox allowedDomains:
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

/** What auto mode's classifier is told about where the task runs and what network use is routine. */
export function claudeAutoMode(local: boolean, allowedNetworkHosts: string[]) {
  return {
    environment: [
      '$defaults',
      local
        ? "Host containment: an automated coding task on the user's own developer machine with open internet; the working directory is the user's workspace, the task has its own scratch folder under the temp directory, and nothing else on the machine is the task's."
        : 'Host containment: an automated coding task on a throwaway cloud machine with open internet and no neighbours; nothing on it is the user’s, it holds no cloud identity, and instance-metadata credentials are never task credentials.',
      ...(allowedNetworkHosts.length
        ? [`Trusted internal domains: ${allowedNetworkHosts.join(', ')}`]
        : []),
    ],
    allow: [
      '$defaults',
      'Public Network Reads: fetching public web pages, documentation, search results and downloads, reading package registries, installing packages, and cloning or fetching public repositories into the workspace or the scratch folder are routine, whatever the host, as long as nothing leaves the machine beyond the request itself: no repository content, secrets, environment or user data in the request body, query or headers.',
    ],
  };
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
 * denies writes there; auto lets them follow cwd.
 *
 * Without the OS sandbox the machine is the boundary, so Bash runs unprompted as it did sandboxed.
 *
 * `unixSockets` are the sockets Bash may connect to on macOS, such as a cloud task's server socket; Linux ignores the list.
 *
 * The scratch folder is writable in auto, and git writes work only there: the
 * checkout's and the extra directories' `.git` are write-denied, and the rest of the temp directory
 * is not writable by default (a deny there would also close the scratch inside it). In auto a
 * command may still leave the sandbox when auto mode's classifier approves the retry, or when the
 * approval hook finds it among the task's approved actions.
 */
export function claudeTurnSettings(
  access: Access,
  cwd: string,
  allowedNetworkHosts: string[] = [],
  additionalDirectories: string[] = [],
  osSandbox = true,
  scratch?: string,
  local = true,
  approvalHook?: string,
  unixSockets: string[] = [],
): string | null {
  const directories = additionalDirectories;
  if (!osSandbox)
    return JSON.stringify({
      permissions: {
        additionalDirectories,
        allow: ['Bash'],
        ...(access === 'read-only' ? { deny: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] } : {}),
      },
      sandbox: { enabled: false },
    });
  if (access === 'read-only') {
    const domains = claudeAllowedDomains(allowedNetworkHosts);

    return JSON.stringify({
      ...(directories.length ? { permissions: { additionalDirectories: directories } } : {}),
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true,
        // Configured hosts only: read-only gets no allowlist of its own.
        network: {
          strictAllowlist: true,
          ...(domains.length ? { allowedDomains: domains } : {}),
          ...(unixSockets.length ? { allowUnixSockets: unixSockets } : {}),
        },
        filesystem: {
          denyWrite: [cwd, ...additionalDirectories],
        },
      },
    });
  }
  // Sandboxed commands skip the permission prompt; only escapes reach the permission layer. The
  // allowlist is reachable with no review; other hosts Claude names on the command for its
  // classifier, which also reviews unsandboxed retries.
  const domains = [...claudeAllowedDomains(allowedNetworkHosts), ...PUBLIC_REGISTRY_HOSTS];

  return JSON.stringify({
    ...(directories.length ? { permissions: { additionalDirectories: directories } } : {}),
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: true,
      autoAllowBashIfSandboxed: true,
      network: {
        allowedDomains: domains,
        ...(unixSockets.length ? { allowUnixSockets: unixSockets } : {}),
        // An allowlisted loopback host also lets commands serve on it (macOS only), so a local dev server runs sandboxed.
        ...(allowedNetworkHosts.some(host => LOOPBACK_HOSTS.has(host))
          ? { allowLocalBinding: true }
          : {}),
      },
      filesystem: {
        ...(scratch ? { allowWrite: [scratch] } : {}),
        denyWrite: [cwd, ...directories].map(directory => path.join(directory, '.git')),
      },
    },
    autoMode: claudeAutoMode(local, allowedNetworkHosts),
    // Allows only a call that exactly matches an approved action; silent otherwise, so the classifier judges.
    ...(approvalHook
      ? {
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: approvalHook }] }],
        },
      }
      : {}),
  });
}

/**
 * Strict schema for a config object (a file's contents or the merged result).
 * Unknown keys and out-of-range values are errors, not warnings. These schemas
 * are the source of truth for the config domain types (types.ts re-exports the
 * z.infer'd types).
 */
// Providers run a turn; engines are what you dispatch: the two
// providers plus "custom", the user's OpenAI-compatible models on codex.
const engineSchema = z.enum(['codex', 'claude', 'custom']);
const effortSchema = z.enum(['low', 'medium', 'high']);
export const accessSchema = z.enum(ACCESS, { error: 'Use read-only or auto' });
/** The config version this Coder reads and writes; a file without one is version 0. */
export const CONFIG_VERSION = 1;
export const MODEL_SPEC_FORMS =
  'Use <name>[/<effort>] or <engine>/<model>[/<effort>], such as sol, sol/low, claude/opus or codex/gpt-6.1-sol/high.';
/** One model choice: `<name>[/<effort>]` or `<engine>/<model>[/<effort>]`. */
export const modelSpecSchema = z
  .string()
  .check(z.refine(spec => Boolean(specParts(spec)), MODEL_SPEC_FORMS));
// One `models` entry, by shape:
// - a string         -> an alias: the model spec its name runs
// - false            -> a built-in or alias turned off
// - an object        -> a custom OpenAI-compatible endpoint (the custom engine); its model is the provider's id
const customModelSchema = z.strictObject({
  baseUrl: z.url(),
  model: z.string().check(z.minLength(1)),
  envKey: z.optional(z.string().check(z.minLength(1))),
  // 'chat' (the default) is translated for codex through the built-in
  // responses->chat bridge; 'responses' passes straight through. `coder model`
  // detects this automatically; the field remains as a manual override.
  wireApi: z.optional(z.enum(['chat', 'responses'])),
  // Tokens; Codex compacts at 90% of it.
  contextWindow: z.optional(z.number().check(z.int(), z.positive())),
  disabled: z.optional(z.boolean()),
});
const modelEntrySchema = z.union([modelSpecSchema, z.literal(false), customModelSchema]);
// Hosts auto tasks reach without review; `readOnlyTasks` lets read-only tasks reach them too.
const networkSchema = z.strictObject({
  allowedHosts: z.array(z.string()),
  readOnlyTasks: z.optional(z.boolean()),
});
// Agent and flow names reach shell commands inside runners, so keep them to safe slugs.
export const agentNameSchema = z
  .string()
  .check(z.regex(/^[a-z0-9][a-z0-9_-]*$/i, 'agent or flow name'));
const skillSourceSchema = z.strictObject({
  repo: z.string().check(z.regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name')),
  path: z.optional(z.string().check(z.regex(/^(?!\/)(?!(.*\/)?\.\.?(\/|$))[^\\]+$/, 'a folder'))),
  ref: z.optional(z.string().check(z.regex(/^(?!-)[\w./-]+$/, 'a branch or tag'))),
  sha: z.optional(z.string().check(z.regex(COMMIT_SHA, 'a full 40-character commit'))),
});
// `agents` holds usage only: how this repo runs an agent. What an agent IS lives in
// `.coder/agents/<id>/agent.json` (see src/agent/definition.ts).
export const agentUsageSchema = z.union([
  z.boolean(),
  z.strictObject({
    model: z.optional(modelSpecSchema),
    access: z.optional(accessSchema),
    // A registered runner's id or name, or the server's own.
    runner: z.optional(z.string().check(z.minLength(1))),
    appendSystem: z.optional(z.string().check(z.maxLength(64 * 1024))),
    integrations: z.optional(
      z.record(z.string(), z.strictObject({ allowedEvents: z.optional(z.array(z.string())) })),
    ),
    connections: z.optional(z.array(z.string())),
    skills: z.optional(z.array(skillSourceSchema)),
    disabled: z.optional(z.boolean()),
  }),
]);
/** The merged, effective shape (everything present after DEFAULT_CONFIG). */
export const mcpEntrySchema = z
  .strictObject({
    connection: z.optional(z.string().check(z.minLength(1))),
    command: z.optional(z.string().check(z.minLength(1))),
    args: z.optional(z.array(z.string())),
    env: z.optional(z.record(z.string(), z.string())),
    url: z.optional(z.string().check(z.minLength(1))),
    type: z.optional(
      z.enum(['stdio', 'http'], {
        error:
          'Use type stdio or http; legacy SSE servers are not supported, use their streamable HTTP URL',
      }),
    ),
    headers: z.optional(z.record(z.string(), z.string())),
    tools: z.optional(z.array(z.string())),
    description: z.optional(z.string()),
    connect: z.optional(z.enum(['start', 'first-use'])),
  })
  .check(
    z.refine(
      entry =>
        entry.connection
          ? [entry.url, entry.command, entry.args, entry.env, entry.headers, entry.type].every(
            value => value === undefined,
          )
          : Boolean(entry.command) !== Boolean(entry.url),
      'Use a connection alone, without url, command, args, env, headers or type; otherwise supply one of command or url',
    ),
  );
const effectiveConfigSchema = z.strictObject({
  $schema: z.optional(z.string()),
  version: z.literal(CONFIG_VERSION),
  // Models in the order tasks try them, the first the default; and the model reviews run on.
  chain: z.array(modelSpecSchema).check(z.minLength(1)),
  reviewModel: modelSpecSchema,
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
  network: networkSchema,
});
export type McpConfigEntry = z.infer<typeof mcpEntrySchema> & { repository?: boolean };
/** What a single config file may contain: any strict subset. */
const configSchema = z.partial(
  z.extend(effectiveConfigSchema, { network: z.partial(networkSchema) }),
);

/** Where a config file's `$schema` points; each Coder server serves it at this path. */
export const CONFIG_SCHEMA_URL = `https://coder.wular.ai/schema/config.v${CONFIG_VERSION}.json`;

/** A config file's JSON Schema, which editors validate it with. */
export const configJsonSchema = () => ({
  $id: CONFIG_SCHEMA_URL,
  ...z.toJSONSchema(configSchema, { unrepresentable: 'any' }),
});

export type Engine = z.infer<typeof engineSchema>;
export type Effort = z.infer<typeof effortSchema>;
export type CustomModelConfig = z.infer<typeof customModelSchema>;
export type ModelEntry = z.infer<typeof modelEntrySchema>;

/** A custom OpenAI-compatible endpoint entry. */
export function isEndpointModel(entry: ModelEntry | undefined): entry is CustomModelConfig {
  return typeof entry === 'object' && entry !== null;
}

/** An alias entry: the model spec its name runs. */
export function isAliasModel(entry: ModelEntry | undefined): entry is string {
  return typeof entry === 'string';
}
export type CoderConfig = z.infer<typeof effectiveConfigSchema>;

/** The strictest of the given levels: read-only when any is, else auto. */
export function strictestAccess(...levels: (Access | null | undefined)[]): Access {
  return levels.includes('read-only') ? 'read-only' : 'auto';
}

/** The hosts a turn reaches without review: the allowlist in auto, and in read-only when `readOnlyTasks` is on. */
export const turnHosts = (access: Access, network: CoderConfig['network']) =>
  access === 'auto' || network.readOnlyTasks ? network.allowedHosts : [];

/** A Codex turn's network: full in auto, else on behind Codex's network proxy with only the
 * given hosts allowed (subdomains too; loopback and IPs exact), else off. */
export function codexTurnNetwork(access: Access, hosts: string[]) {
  const networkAccess = access === 'auto';
  if (networkAccess || !hosts.length) return { networkAccess, configOverrides: {} };
  const domains = hosts.map(host => {
    const name = host.replace(/^\[(.*)\](?::\d+)?$/, '$1').replace(/^([^:]+):\d+$/, '$1');

    return [net.isIP(name) || LOOPBACK_HOSTS.has(name) ? name : `**.${name}`, 'allow'];
  });

  return {
    networkAccess: true,
    configOverrides: {
      'features.network_proxy.enabled': true,
      'features.network_proxy.domains': Object.fromEntries(domains),
    },
  };
}

const HOST_NAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*(?::\d{1,5})?$/i;

/** A host name, IP address, or either with a port, as the engines' network policies take them. */
function isNetworkHost(host: string): boolean {
  if (net.isIP(host)) return true;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(host);
  return bracketed ? net.isIPv6(bracketed[1]!) : host.length <= 253 && HOST_NAME.test(host);
}

/** Turn a model name off or back on: an endpoint by its flag, any other name by false; an alias is removed instead. */
export function toggleModel(models: Record<string, ModelEntry>, name: string, disable: boolean) {
  const entry = models[name];
  if (disable && typeof entry === 'string')
    throw new Error(`Alias "${name}" can't be turned off; remove it instead.`);
  if (isEndpointModel(entry)) {
    if (disable) entry.disabled = true;
    else delete entry.disabled;
  } else if (disable) models[name] = false;
  else if (entry === false) delete models[name];
}

/** Drop a model entry and every model setting that names it. */
export function removeModel(
  config: { models?: Record<string, unknown>; chain?: unknown[]; reviewModel?: unknown },
  name: string,
): void {
  delete config.models?.[name];
  // An engine's alias falls back to its built-in model, so its entries stay.
  const names = (spec: unknown) =>
    !isEngine(name) && typeof spec === 'string' && spec.split('/').slice(0, 2).includes(name);
  if (names(config.reviewModel)) delete config.reviewModel;
  const chain = config.chain?.filter(spec => !names(spec));
  if (chain?.length) config.chain = chain;
  else delete config.chain;
}

/** One line per schema issue, each union branch's included, without a loaded Zod locale. */
export function schemaIssues(
  issues: ReadonlyArray<z.core.$ZodIssue>,
  prefix: PropertyKey[] = [],
): string[] {
  return issues.flatMap(issue =>
    issue.code === 'invalid_union'
      ? issue.errors.flatMap(branch => schemaIssues(branch, [...prefix, ...issue.path]))
      : [
          `${[...prefix, ...issue.path].map(String).join('.') || '(root)'}: ${
            issue.code === 'unrecognized_keys'
              ? `Unrecognized ${issue.keys.length === 1 ? 'key' : 'keys'}: ${issue.keys.map(key => JSON.stringify(key)).join(', ')}`
              : issue.message
          }`,
        ],
  );
}

/**
 * Version 0 to 1: engine defaults become the engines' aliases, aliases one spec string and toggles
 * false, approval hosts and the Codex network switch the network section, colon specs slash specs, and an
 * agent's engine, model and effort one spec. Pure JSON to JSON, with a note per change.
 */
function toVersion1(old: Record<string, any>): { config: Record<string, any>; notes: string[] } {
  const config = structuredClone(old);
  const notes: string[] = [];
  const slash = (value: unknown, at: string) => {
    if (typeof value !== 'string' || !value.includes(':')) return value;
    const next = value.replaceAll(':', '/');
    notes.push(`${at}: "${value}" is now "${next}"`);

    return next;
  };
  const spec = (engine: unknown, model: unknown, effort: unknown) =>
    [engine, model ?? (effort ? splitEngineSpec(BUILTIN_MODELS[engine as string]!).model : undefined), effort]
      .filter(Boolean)
      .join('/');

  const models: Record<string, any> = { ...config.models };
  for (const [name, entry] of Object.entries(models)) {
    if (typeof entry === 'string') models[name] = slash(entry, `models.${name}`);
    if (!entry || typeof entry !== 'object' || 'baseUrl' in entry) continue;
    if ('provider' in entry || 'model' in entry) {
      models[name] = entry.disabled
        ? false
        : 'provider' in entry
          ? spec(entry.provider, entry.model, entry.effort)
          : String(slash(entry.model, `models.${name}`));
      notes.push(`models.${name}: the alias is now ${JSON.stringify(models[name])}`);
    } else if (entry.disabled === true) {
      models[name] = false;
      notes.push(`models.${name}: the toggle is now false`);
    } else {
      delete models[name];
      notes.push(`models.${name}: an enable toggle is not needed and was removed`);
    }
  }
  const network: Record<string, unknown> = {};
  for (const [engine, entry] of Object.entries<Record<string, any>>(config.engines ?? {})) {
    const { model, effort } = entry ?? {};
    if ((model || effort) && models[engine] === undefined && (model || engine !== 'custom')) {
      models[engine] = spec(engine, model, effort);
      notes.push(`engines.${engine}: its model is now the alias models.${engine} = "${models[engine]}"`);
    }
    if (engine === 'codex' && entry?.network === true) {
      network.readOnlyTasks = true;
      notes.push('engines.codex.network is now network.readOnlyTasks, for every engine');
    } else if (engine === 'codex' && entry?.network === false) {
      notes.push('engines.codex.network: false was removed; auto tasks keep their network');
    }
  }
  delete config.engines;
  if (config.approvals && typeof config.approvals === 'object') {
    const { allowedNetworkHosts, ...rest } = config.approvals;
    if (allowedNetworkHosts) {
      network.allowedHosts = allowedNetworkHosts;
      notes.push('approvals.allowedNetworkHosts is now network.allowedHosts');
    }
    if (Object.keys(rest).length) config.approvals = rest;
    else delete config.approvals;
  }
  if (Object.keys(network).length) config.network = { ...config.network, ...network };
  if (Object.keys(models).length) config.models = models;
  if (Array.isArray(config.chain))
    config.chain = config.chain.map((entry: unknown, index: number) => slash(entry, `chain.${index}`));
  if (config.reviewModel) config.reviewModel = slash(config.reviewModel, 'reviewModel');
  for (const [id, usage] of Object.entries<any>(config.agents ?? {})) {
    if (!usage || typeof usage !== 'object') continue;
    if (usage.engine || usage.effort) {
      const { engine, model, effort, ...rest } = usage;
      // An alias keeps its own engine.
      const runs = engine ?? (typeof models[model] === 'string' ? undefined : inferEngine(model, { models }));
      config.agents[id] = { ...rest, model: spec(runs, model, effort) };
      notes.push(`agents.${id}: its engine, model and effort are now model "${config.agents[id].model}"`);
    } else if (usage.model) usage.model = slash(usage.model, `agents.${id}.model`);
  }
  config.version = 1;

  return { config, notes };
}

/** Each patch turns its index's config version into the next; a config runs those from its version on. */
export const CONFIG_PATCHES = [toVersion1];

/** A config as this Coder reads it, patched from its version (0 when it has none) with a note per change; a newer one is refused. */
export function upgradeConfig(raw: Record<string, any>): {
  config: Record<string, any>;
  notes: string[];
  version: number;
} {
  const version = typeof raw.version === 'number' ? raw.version : 0;
  if (version > CONFIG_VERSION)
    throw new Error(`Written by a newer Coder (config version ${version}); run coder upgrade.`);
  let config = raw;
  const notes: string[] = [];
  for (const patch of CONFIG_PATCHES.slice(version)) {
    const next = patch(config);
    config = next.config;
    notes.push(...next.notes);
  }

  return { config, notes, version };
}

/** Returns human-readable errors; empty array means valid. */
export function validateConfig(candidate: unknown): string[] {
  const result = configSchema.safeParse(candidate);
  if (!result.success) return schemaIssues(result.error.issues);
  const config = deepMerge(DEFAULT_CONFIG, result.data);
  const errors: string[] = [];
  for (const [index, host] of (result.data.network?.allowedHosts ?? []).entries()) {
    if (!isNetworkHost(host))
      errors.push(`network.allowedHosts.${index}: "${host}" is not a host name or IP address`);
  }
  for (const [name, entry] of Object.entries(result.data.models ?? {})) {
    if (EFFORTS.has(name)) {
      errors.push(`models.${name}: ${name} is an effort, not a model name`);
      continue;
    }
    // Alias expansion is one level: the target must be an engine model id,
    // a built-in alias or, for `custom` alone, an endpoint; never another alias.
    const target = isAliasModel(entry) ? aliasTarget(entry, config) : undefined;
    const targetEntry = target?.model ? config.models?.[target.model] : undefined;
    if (isEngine(name)) {
      if (target?.engine !== name)
        errors.push(`models.${name}: The ${name} alias names a ${name} model, such as ${name}/<model>`);
      else if (name === 'custom' && !(targetEntry && isEndpointModel(targetEntry)))
        errors.push(`models.custom: "${target.model ?? ''}" names no custom model`);
      continue;
    }
    if (target?.engine === 'custom') {
      errors.push(`models.${name}: Only custom aliases a custom model`);
      continue;
    }
    if (targetEntry && !isEndpointModel(targetEntry))
      errors.push(`models.${name}: alias target "${target!.model}" is itself a config entry`);
    // False is valid on any name: built-ins, entries defined in another config
    // layer, or raw model slugs passed straight to an engine.
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

/** The repository config under its workspace root. */
export function resolveWorkspaceConfigFile(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.coder', 'config.json');
}

/** A server task's workspace config, as JSON; the repo's config may then only narrow it. */
export const WORKSPACE_CONFIG_ENV = 'CODER_WORKSPACE_CONFIG';

/** What a repo config may change under a server workspace config: fewer chain entries, models, and hosts, another review model. */
function narrowed(base: CoderConfig, repo: Partial<CoderConfig>): Partial<CoderConfig> {
  const hosts = repo.network?.allowedHosts?.filter(host =>
    base.network.allowedHosts.includes(host),
  );
  const disabled = Object.entries(repo.models ?? {}).filter(
    ([, entry]) => entry === false || (isEndpointModel(entry) && entry.disabled),
  );
  return {
    ...(repo.mcp ? { mcp: repo.mcp } : {}),
    ...(repo.chain ? { chain: repo.chain.filter(spec => base.chain.includes(spec)) } : {}),
    ...(repo.reviewModel ? { reviewModel: repo.reviewModel } : {}),
    models: Object.fromEntries(disabled.map(([name]) => [name, false])),
    ...(hosts ? { network: { ...base.network, allowedHosts: hosts } } : {}),
  };
}

/** A layer as this Coder reads it: an older user file is rewritten in place beside a `.bak`, an older repo file patched in memory until `coder config migrate`. */
function loadedLayer(source: string, raw: Record<string, unknown>, repository: boolean) {
  const { config, version } = upgradeConfig(raw);
  if (version === CONFIG_VERSION || !source.endsWith('.json')) return config;
  if (repository) {
    process.stderr.write(
      `${source} is config version ${version}; coder config migrate rewrites it.\n`,
    );
    return config;
  }
  fs.copyFileSync(source, `${source}.bak`);
  fs.writeFileSync(source, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  process.stderr.write(
    `Updated ${source} to config version ${CONFIG_VERSION}; the old one is ${source}.bak.\n`,
  );

  return config;
}

/** Rewrite a config file at this Coder's version: the user's, or the repo's with `workspace`. Returns the file and a note per change. */
export function migrateConfigFile(
  cwd: string,
  workspace?: boolean,
): { file: string; version: number; notes: string[] } {
  const file = configTargetFile(cwd, workspace);
  const raw = readJsonIfExists(file);
  if (!raw) return { file, version: CONFIG_VERSION, notes: [] };
  const { config, notes, version } = upgradeConfig(raw as Record<string, unknown>);
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`Invalid config in ${file}:\n  ${errors.join('\n  ')}`);
  if (version !== CONFIG_VERSION)
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  return { file, version, notes };
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
  const repositoryMcp = new Set<string>();
  for (const [source, raw] of layers) {
    if (!raw) {
      continue;
    }
    const value = loadedLayer(source, raw as Record<string, unknown>, source === repoFile);
    const errors = validateConfig(value);
    if (errors.length) {
      throw new Error(`Invalid config in ${source}:\n  ${errors.join('\n  ')}`);
    }
    const layer =
      server && source === repoFile ? narrowed(config, value) : (value as Partial<CoderConfig>);
    const mcp = { ...config.mcp, ...layer.mcp };
    for (const name of Object.keys(layer.mcp ?? {})) {
      if (source === repoFile) repositoryMcp.add(name);
      else repositoryMcp.delete(name);
    }
    config = { ...deepMerge(config, layer), ...(Object.keys(mcp).length ? { mcp } : {}) };
  }
  const errors = validateConfig(config);
  if (errors.length) {
    throw new Error(`Invalid merged config:\n  ${errors.join('\n  ')}`);
  }
  for (const [name, entry] of Object.entries(config.mcp ?? {}))
    markRepositoryMcp({ [name]: entry }, repositoryMcp.has(name));

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
      raw = raw && upgradeConfig(raw).config;
    } catch {
      continue;
    }
    if (!isEndpointModel(raw?.models?.[alias])) {
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
function hasExplicitEndpoint(baseUrl: string): boolean {
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

/** Provider headers that tell the chat bridge where a custom model's thread goes. */
export const BRIDGE_HEADERS = {
  baseUrl: 'x-coder-base-url',
  wireApi: 'x-coder-wire-api',
};

/** Codex-engine overrides for one custom model: provider id and config. */
interface CustomModelResolution {
  modelProvider: string;
  configOverrides: Record<string, unknown>;
}

/**
 * Codex engine overrides for a custom (user-configured, OpenAI-compatible)
 * model alias, served through the app-server's bridge. The provider is
 * injected per-thread, with the upstream and key as its headers, so neither
 * the bridge nor the user's ~/.codex/config.toml holds them.
 */
export function resolveCustomModel(
  alias: string,
  entry: CustomModelConfig,
  bridgeUrl: string,
): CustomModelResolution {
  const key = entry.envKey ? process.env[entry.envKey] : undefined;
  if (entry.envKey && !key) throw new Error(`Missing environment variable: \`${entry.envKey}\`.`);
  const providerId = `coder-${alias}`;
  return {
    modelProvider: providerId,
    configOverrides: {
      [`model_providers.${providerId}`]: {
        name: alias,
        base_url: `${bridgeUrl}/v1`,
        // codex itself always speaks the Responses API (>= 0.144 dropped
        // 'chat'); chat-only endpoints are translated by the bridge.
        wire_api: 'responses',
        http_headers: {
          [BRIDGE_HEADERS.baseUrl]: entry.baseUrl,
          [BRIDGE_HEADERS.wireApi]: entry.wireApi ?? 'chat',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
      },
      ...(entry.contextWindow ? { model_context_window: entry.contextWindow } : {}),
    },
  };
}

/** The Codex model id a name runs: a built-in Codex alias's, else the name itself. */
export function resolveCodexModel(alias?: string | null): string | null {
  if (!alias) {
    return null;
  }
  const [engine, model] = (BUILTIN_MODELS[alias] ?? '').split('/');

  return engine === 'codex' && model ? model : alias;
}

/** A built-in alias name, independent of config state. */
export function isBuiltinAlias(name: string): boolean {
  return Object.hasOwn(BUILTIN_MODELS, name);
}

/** The spec a name aliases: the user's entry, else the built-in; none for a name turned off or no alias. */
function aliasOf(config: Pick<CoderConfig, 'models'>, name: string): string | undefined {
  const entry = config.models?.[name];
  if (entry !== undefined) return isAliasModel(entry) ? entry : undefined;

  return isBuiltinAlias(name) ? BUILTIN_MODELS[name] : undefined;
}

/** Turned off: false, or an endpoint marked disabled. */
function isModelDisabled(config: CoderConfig, name?: string | null): boolean {
  const entry = name ? config.models?.[name] : undefined;

  return entry === false || (isEndpointModel(entry) && Boolean(entry.disabled));
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

const isEngine = (value?: string): value is Engine =>
  value === 'codex' || value === 'claude' || value === 'custom';

/** A model spec's parts by position, or undefined when it has another shape. */
function specParts(spec: string): { engine?: Engine; model?: string; effort?: Effort } | undefined {
  const parts = spec.split('/').map(part => part.trim());
  const [first, second, third] = parts;
  const isEffort = (value?: string): value is Effort => Boolean(value && EFFORTS.has(value));
  if (!first || isEffort(first) || parts.length > 3) return undefined;
  const name = isEngine(first) ? { engine: first } : { model: first };
  if (parts.length === 1) return name;
  if (parts.length === 2 && isEffort(second)) return { ...name, effort: second };
  if (!isEngine(first) || !second || isEffort(second)) return undefined;
  const builtin = BUILTIN_MODELS[second];
  if (builtin && !builtin.startsWith(`${first}/`)) return undefined;
  if (third !== undefined && !isEffort(third)) return undefined;

  return { engine: first, model: second, ...(third ? { effort: third } : {}) };
}

/** Split `<name>[/<effort>]` or `<engine>/<model>[/<effort>]`; a lone name is an engine or a model. */
export function splitEngineSpec(spec: string): {
  engine?: Engine;
  model?: string;
  effort?: Effort;
} {
  const parts = specParts(spec);
  if (!parts) throw new Error(`Invalid model "${spec}". ${MODEL_SPEC_FORMS}`);

  return parts;
}

/**
 * Resolve a model spec against config: a name, the engines' included, runs its
 * alias (the user's, else the built-in), expanded one level; an engine is
 * inferred for a lone model name; an unset effort is the alias's, else medium.
 * Throws when the resolved model is disabled in config.
 */
export function parseEngineSpec(
  spec: string | null | undefined,
  config: CoderConfig,
): { engine: Engine; model: string | null; effort: Effort | null } | null {
  if (!spec) {
    return null;
  }
  const parts = splitEngineSpec(String(spec).trim());
  let engine = parts.engine ?? null;
  let model = parts.model ?? null;
  let effort = parts.effort ?? null;

  assertModelEnabled(config, model ?? engine);
  const entry = aliasOf(config, model ?? engine ?? '');
  if (entry) {
    const target = aliasTarget(entry, config);
    const runs = target.engine;
    if (engine && engine !== runs) {
      throw new Error(`Alias "${model ?? engine}" runs on ${runs}, not ${engine}.`);
    }
    engine = runs;
    effort = parts.effort ?? target.effort ?? null;
    model = target.model ?? null;
  }

  engine ??= inferEngine(model ?? undefined, config);
  assertModelEnabled(config, model);

  // A built-in Codex name that remains, such as the `sol` of `codex/sol`, runs its id.
  const resolvedModel = engine === 'codex' ? resolveCodexModel(model) : model;
  assertModelEnabled(config, resolvedModel);
  return {
    engine,
    model: resolvedModel,
    effort: effort ?? DEFAULT_EFFORT,
  };
}

/** The engine a lone model name runs on: a custom endpoint's, Claude for a Claude-looking slug, else Codex. */
function inferEngine(model: string | undefined, config: Pick<CoderConfig, 'models'>): Engine {
  const entry = model ? config.models?.[model] : undefined;
  if (isEndpointModel(entry)) return 'custom';

  return model && /^(?:claude-|opus|sonnet|haiku|fable)/i.test(model) ? 'claude' : 'codex';
}

/** What an alias runs: its spec's parts, its engine inferred when the spec names none. */
export function aliasTarget(
  spec: string,
  config: Pick<CoderConfig, 'models'>,
): { engine: Engine; model?: string; effort?: Effort } {
  const target = splitEngineSpec(spec);

  return { ...target, engine: target.engine ?? inferEngine(target.model, config) };
}

/** A resolved model as people read it: the built-in name that runs it, such as `sol`, else its id. */
export function modelName(option: { engine: string; model: string | null }): string {
  const spec = `${option.engine}/${option.model}`;

  return (
    Object.keys(BUILTIN_MODELS).find(name => !isEngine(name) && BUILTIN_MODELS[name] === spec) ??
    option.model ??
    option.engine
  );
}

/** Whether two resolved choices run the same model, whatever their effort. */
export function sameModel(
  a: { engine: Engine; model: string | null },
  b: { engine: Engine; model: string | null },
): boolean {
  return a.engine === b.engine && resolveCodexModel(a.model) === resolveCodexModel(b.model);
}

export function writeUserConfig(config: Partial<CoderConfig>): string {
  const filePath = resolveUserConfigFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ ...config, version: CONFIG_VERSION }, null, 2)}\n`,
    'utf8',
  );
  return filePath;
}

function getPath(object: unknown, dotted: string): unknown {
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
function configGet(cwd: string, key?: string): unknown {
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
  const current: Record<string, any> = upgradeConfig(
    fs.existsSync(targetFile) ? JSON.parse(fs.readFileSync(targetFile, 'utf8')) : {},
  ).config;
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

export const config = {
  /** A config value by dotted key (or the whole effective config). */
  get: (key?: string, opts: { cwd?: string } = {}) => configGet(path.resolve(opts.cwd ?? '.'), key),
  /** Set a config value; `workspace` targets the repo file instead of the user file. */
  set: (
    key: string,
    value: unknown,
    opts: { workspace?: boolean; cwd?: string; unset?: boolean } = {},
  ) => configSet(path.resolve(opts.cwd ?? '.'), key, value, opts),
};
