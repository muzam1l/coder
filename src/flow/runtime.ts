/** Flow runtime: ALS context, primitives, and the run executor. See docs/flows.md. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CoderError, dispatchTask, waitTask } from '../lib/dispatch.js';
import { AUTO_ARCHIVE_MS, assertValidId, isValidId, listJobs, processStartMs, readJob, resolveCoderHome } from '../lib/state.js';
import { createJsonlTail } from '../lib/fsx.js';
import { spawnArchiveSweep } from '../cmd/archive.js';
import { stopTaskCore } from '../cmd/stop.js';
import { ageMs, formatAgentSpec } from '../lib/ui.js';
import { TERMINAL_STATUSES, type TokenUsage } from '../lib/types.js';
import { Journal, fingerprint, readJournal } from './journal.js';
import { resolveFlow } from './discover.js';
import type {
  FlowEvent,
  FlowSchema,
  FlowRecord,
  FlowStep,
  FlowTaskOptions,
  FlowTaskResult,
  GateResult,
} from './types.js';

// ---------------------------------------------------------------------------
// ALS: run services (ctx) and per-invocation scope (args + nesting depth)
// ---------------------------------------------------------------------------

/** Progress callbacks a foreground caller can attach to a run. */
export interface FlowHooks {
  /** Fired once the run is armed, with a stop handle for a SIGINT handler. */
  onStart?: (h: { runId: string; requestStop: () => void; runningIds: () => string[] }) => void;
  /** A task was dispatched (real dispatches only, never dry-run). */
  onTaskStart?: (info: {
    taskId: string;
    name?: string;
    prompt: string;
    agent?: string;
    depth?: number;
  }) => void;
  /** A task reached a terminal state. */
  onTaskEnd?: (info: { taskId: string; status: string; tokens: TokenUsage | null }) => void;
  /** A gate command finished. */
  onGate?: (info: { cmd: string; ok: boolean; code: number; depth?: number }) => void;
  /** The flow called log(). */
  onLog?: (msg: string, depth?: number) => void;
  /** A sub-flow started (depth is the sub-flow's own nesting level). */
  onFlowStart?: (info: { name: string; depth: number }) => void;
  /** A resume replayed recorded steps from the journal. */
  onReplay?: (count: number) => void;
}

interface RunContext {
  runId: string;
  runDir: string;
  cwd: string;
  journal: Journal;
  semaphore: Semaphore;
  maxTasks: number;
  dryRun: boolean;
  ledger: Record<string, TokenUsage>;
  running: Set<string>;
  taskCount: number;
  stopping: boolean;
  hooks: FlowHooks;
}

interface Scope {
  args: unknown;
  depth: number;
}

// Anchored on globalThis: the CLI bundle and the `@wular/coder/flow` bundle each
// carry their own copy of this module, but a flow author's primitives must read
// the very context the CLI set. Sharing the ALS instances across both copies is
// what makes journaling, concurrency, and args work end to end.
const G = globalThis as unknown as {
  __coderFlowCtxALS?: AsyncLocalStorage<RunContext>;
  __coderFlowScopeALS?: AsyncLocalStorage<Scope>;
};
const ctxALS = (G.__coderFlowCtxALS ??= new AsyncLocalStorage<RunContext>());
const scopeALS = (G.__coderFlowScopeALS ??= new AsyncLocalStorage<Scope>());

export function currentScopeArgs(): unknown {
  return scopeALS.getStore()?.args;
}

// Nesting level of the currently executing flow scope (0 = top-level).
function currentDepth(): number {
  return scopeALS.getStore()?.depth ?? 0;
}

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Claim the slot synchronously (or hand it over directly on release):
    // counting after an await would let a new arrival observe a stale count
    // and over-admit past the limit.
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) {
        next(); // slot passes to the waiter; `active` is unchanged
      } else {
        this.active -= 1;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

function addTokens(a: TokenUsage | null, b: TokenUsage | null | undefined): TokenUsage | null {
  if (!b) return a;
  if (!a) return { ...b };
  return {
    input: a.input + b.input,
    cachedInput: a.cachedInput + b.cachedInput,
    output: a.output + b.output,
    total: a.total + b.total,
  };
}

function recordLedger(ctx: RunContext, res: FlowTaskResult): void {
  if (!res.tokens) return;
  const key = res.model ?? 'default';
  ctx.ledger[key] = addTokens(ctx.ledger[key] ?? null, res.tokens)!;
}

// ---------------------------------------------------------------------------
// returns-schema helpers (duck-typed over any zod-like schema)
// ---------------------------------------------------------------------------

function isZodLike(s: unknown): s is { safeParse: (v: unknown) => any } {
  return !!s && typeof (s as any).safeParse === 'function';
}

async function toJSONSchema(schema: unknown): Promise<unknown | null> {
  try {
    const zod = (await import('zod')) as any;
    if (typeof zod.toJSONSchema === 'function') {
      return zod.toJSONSchema(schema);
    }
  } catch {
    // zod unavailable or schema not convertible — fall back to generic prose.
  }
  return null;
}

async function formatInstructions(schema: unknown): Promise<string> {
  const json = await toJSONSchema(schema);
  const shape = json
    ? `matching this JSON Schema:\n${JSON.stringify(json, null, 2)}`
    : 'matching the requested shape';
  return `Reply with ONLY a single JSON object ${shape}\nNo prose, no markdown fences — just the JSON object.`;
}

// Strip markdown fences, extract the first balanced JSON object, parse it.
function extractJson(text: string): unknown {
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) body = fence[1]!.trim();
  const start = body.indexOf('{');
  if (start === -1) throw new Error('no JSON object found in reply');
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(body.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON object in reply');
}

function validate(schema: unknown, value: unknown): { ok: true; data: unknown } | { ok: false; errors: string } {
  if (!isZodLike(schema)) return { ok: true, data: value };
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error?.issues ?? parsed.error?.errors ?? [];
  const errors = Array.isArray(issues)
    ? issues.map((i: any) => `${(i.path ?? []).join('.') || '(root)'}: ${i.message}`).join('; ')
    : String(parsed.error);
  return { ok: false, errors };
}

// ---------------------------------------------------------------------------
// task()
// ---------------------------------------------------------------------------

function dispatchOptsFrom(opts: FlowTaskOptions, cwd: string, ctx?: RunContext) {
  return {
    cwd,
    agent: opts.agent,
    model: opts.model,
    effort: opts.effort,
    permissions: opts.permissions,
    name: opts.name,
    system: opts.system,
    wait: true,
    flowRunId: ctx?.runId,
  };
}

async function runOneTask(
  prompt: string,
  opts: FlowTaskOptions,
  ctx: RunContext | undefined,
  resume?: string,
): Promise<{ taskId: string; status: string; output: string; tokens: TokenUsage | null; model: string | null }> {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : ctx?.cwd ?? process.cwd();
  const dispatch = await dispatchTask({
    prompt,
    ...dispatchOptsFrom(opts, cwd, ctx),
    resume: resume ?? opts.resume,
  });
  ctx?.running.add(dispatch.taskId);
  // Resolved engine spec ("claude/opus/medium") from the job record — the
  // dispatch may have picked the agent via the chain, not the flow author.
  const job = readJob(cwd, dispatch.taskId);
  const agent = job ? formatAgentSpec(job) : undefined;
  ctx?.hooks.onTaskStart?.({
    taskId: dispatch.taskId,
    name: opts.name,
    prompt,
    agent,
    depth: currentDepth(),
  });
  try {
    const waited = await waitTask(cwd, dispatch.taskId);
    return {
      taskId: dispatch.taskId,
      status: waited.status,
      output: waited.result?.finalMessage ?? '',
      tokens: waited.result?.tokens ?? null,
      model: waited.result?.model ?? waited.job.model ?? null,
    };
  } finally {
    ctx?.running.delete(dispatch.taskId);
  }
}

async function executeTask(
  prompt: string,
  opts: FlowTaskOptions,
  ctx?: RunContext,
): Promise<FlowTaskResult> {
  let finalPrompt = prompt;
  if (opts.returns) {
    finalPrompt = `${prompt}\n\n${await formatInstructions(opts.returns)}`;
  }

  if (ctx?.dryRun) {
    process.stdout.write(`\n[dry-run] task${opts.name ? ` (${opts.name})` : ''}:\n${finalPrompt}\n`);
    const shown = { ...opts, returns: opts.returns ? '<schema>' : undefined };
    process.stdout.write(`[dry-run] opts: ${JSON.stringify(shown)}\n`);
    return { taskId: 'dry', status: 'completed', output: '[dry-run]', data: undefined, tokens: null, model: opts.model ?? null };
  }

  const first = await runOneTask(finalPrompt, opts, ctx);
  if (first.status !== 'completed') {
    const result: FlowTaskResult = { ...first, data: undefined };
    throw new CoderError('task-failed', `Task ${first.taskId} ${first.status}: ${first.output || 'no output'}`, { taskId: first.taskId, result });
  }

  let output = first.output;
  let tokens = first.tokens;
  let data: unknown;

  if (opts.returns) {
    let parsed: { ok: true; data: unknown } | { ok: false; errors: string };
    try {
      parsed = validate(opts.returns, extractJson(output));
    } catch (e) {
      parsed = { ok: false, errors: e instanceof Error ? e.message : String(e) };
    }
    if (!parsed.ok) {
      const retryPrompt = `Your previous reply did not match the required format: ${parsed.errors}\n\n${await formatInstructions(opts.returns)}`;
      const retry = await runOneTask(retryPrompt, opts, ctx, first.taskId);
      output = retry.output || output;
      tokens = addTokens(tokens, retry.tokens);
      try {
        const reparsed = validate(opts.returns, extractJson(output));
        if (!reparsed.ok) throw new Error(reparsed.errors);
        data = reparsed.data;
      } catch (e) {
        const result: FlowTaskResult = { taskId: first.taskId, status: 'completed', output, data: undefined, tokens, model: first.model };
        throw new CoderError('task-failed', `Task ${first.taskId} produced no valid structured output: ${e instanceof Error ? e.message : String(e)}`, { taskId: first.taskId, result });
      }
    } else {
      data = parsed.data;
    }
  }

  return { taskId: first.taskId, status: 'completed', output, data, tokens, model: first.model };
}

async function returnsPart(returns: unknown): Promise<unknown> {
  if (!returns) return undefined;
  const json = await toJSONSchema(returns);
  return json ?? '<schema>';
}

// With a `returns` schema, `data` is guaranteed (validation failure throws
// instead of resolving) — the overload spares callers a needless `?.`/`!`.
/**
 * Dispatch one coder task and await its result. With a `returns` schema the
 * reply is validated and `data` is guaranteed (validation failure throws).
 * Inside a flow run, results are journaled and replayed on resume.
 */
export async function task<T>(
  prompt: string,
  opts: FlowTaskOptions<T> & { returns: FlowSchema<T> },
): Promise<FlowTaskResult<T> & { data: T }>;
/** Dispatch one coder task and await its result. Mirrors `coder run`. */
export async function task(
  prompt: string,
  opts?: FlowTaskOptions,
): Promise<FlowTaskResult>;
export async function task<T = unknown>(
  prompt: string,
  opts: FlowTaskOptions<T> = {},
): Promise<FlowTaskResult<T>> {
  const ctx = ctxALS.getStore();
  if (!ctx) {
    return executeTask(prompt, opts) as Promise<FlowTaskResult<T>>;
  }
  const fp = fingerprint('task', {
    prompt,
    agent: opts.agent,
    model: opts.model,
    effort: opts.effort,
    permissions: opts.permissions,
    name: opts.name,
    system: opts.system,
    resume: opts.resume,
    cwd: opts.cwd,
    returns: await returnsPart(opts.returns),
  });
  const hit = ctx.journal.replay(fp);
  if (hit) return hit.result as FlowTaskResult<T>;

  ctx.taskCount += 1;
  if (ctx.taskCount > ctx.maxTasks) {
    throw new Error(
      `Flow exceeded --max-tasks (${ctx.maxTasks}). Raise it with --max-tasks, or fix a runaway loop; the run is resumable.`,
    );
  }
  return ctx.semaphore.run(async () => {
    const startedAt = new Date().toISOString();
    let res: FlowTaskResult;
    try {
      res = await executeTask(prompt, opts, ctx);
    } catch (e) {
      // Surface the failed task before rethrowing (a completed status here means
      // the reply failed structured-output validation).
      const failed = e instanceof CoderError ? (e.result as FlowTaskResult | undefined) : undefined;
      if (failed) {
        ctx.hooks.onTaskEnd?.({
          taskId: failed.taskId,
          status: failed.status === 'completed' ? 'failed' : failed.status,
          tokens: failed.tokens,
        });
      }
      throw e;
    }
    recordLedger(ctx, res);
    if (!ctx.dryRun) {
      ctx.hooks.onTaskEnd?.({ taskId: res.taskId, status: res.status, tokens: res.tokens });
    }
    ctx.journal.record({ kind: 'task', fingerprint: fp, result: res, taskId: res.taskId, tokens: res.tokens, startedAt, endedAt: new Date().toISOString() });
    return res as FlowTaskResult<T>;
  });
}

// ---------------------------------------------------------------------------
// gate()
// ---------------------------------------------------------------------------

// Captured gate output is journaled and kept in memory — cap it so a chatty
// command (a full build log) can't balloon the journal or the process heap.
const GATE_OUTPUT_CAP = 256 * 1024;

async function executeGate(cmd: string, cwd: string): Promise<GateResult> {
  return new Promise(resolve => {
    const child = spawn(cmd, { shell: true, cwd });
    let out = '';
    const take = (d: Buffer | string) => {
      if (out.length >= GATE_OUTPUT_CAP) return;
      out += d;
      if (out.length >= GATE_OUTPUT_CAP) {
        out = `${out.slice(0, GATE_OUTPUT_CAP)}\n... [gate output truncated]`;
      }
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', err => resolve({ ok: false, code: 1, output: String(err.message ?? err).trim() }));
    child.on('close', code => resolve({ ok: code === 0, code: code ?? 0, output: out.trim() }));
  });
}

/**
 * Run a shell command as a checkpoint. Never throws — inspect `ok`/`code`;
 * output is captured (capped) and journaled for resume.
 */
export async function gate(cmd: string, opts: { cwd?: string } = {}): Promise<GateResult> {
  const ctx = ctxALS.getStore();
  const cwd = opts.cwd ? path.resolve(opts.cwd) : ctx?.cwd ?? process.cwd();
  if (!ctx) {
    return executeGate(cmd, cwd);
  }
  const fp = fingerprint('gate', { cmd, cwd: opts.cwd });
  const hit = ctx.journal.replay(fp);
  if (hit) return hit.result as GateResult;

  if (ctx.dryRun) {
    process.stdout.write(`\n[dry-run] gate: ${cmd}\n`);
    const res: GateResult = { ok: true, code: 0, output: '' };
    ctx.journal.record({ kind: 'gate', fingerprint: fp, result: res, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() });
    return res;
  }
  const startedAt = new Date().toISOString();
  const res = await executeGate(cmd, cwd);
  ctx.hooks.onGate?.({ cmd, ok: res.ok, code: res.code, depth: currentDepth() });
  ctx.journal.record({ kind: 'gate', fingerprint: fp, result: res, startedAt, endedAt: new Date().toISOString() });
  return res;
}

// ---------------------------------------------------------------------------
// pipeline()
// ---------------------------------------------------------------------------

type Stage = (prev: any, item: any, index: number) => unknown;
type S<P, T, R> = (prev: P, item: T, index: number) => R | Promise<R>;

// Overloads chain each stage's result into the next; a thrown stage yields null.
/**
 * Run each item through the stages independently, with no barrier between
 * stages. Each stage receives `(prev, item, index)`; a thrown stage drops
 * that item to `null` and skips its remaining stages.
 */
export async function pipeline<T, A>(items: T[], s1: S<T, T, A>): Promise<(A | null)[]>;
export async function pipeline<T, A, B>(items: T[], s1: S<T, T, A>, s2: S<A, T, B>): Promise<(B | null)[]>;
export async function pipeline<T, A, B, C>(
  items: T[],
  s1: S<T, T, A>,
  s2: S<A, T, B>,
  s3: S<B, T, C>,
): Promise<(C | null)[]>;
export async function pipeline<T, A, B, C, D>(
  items: T[],
  s1: S<T, T, A>,
  s2: S<A, T, B>,
  s3: S<B, T, C>,
  s4: S<C, T, D>,
): Promise<(D | null)[]>;
export async function pipeline<T>(items: T[], ...stages: Stage[]): Promise<any[]>;
export async function pipeline<T>(items: T[], ...stages: Stage[]): Promise<any[]> {
  return Promise.all(
    items.map(async (item, index) => {
      let value: unknown = item;
      for (const stage of stages) {
        try {
          value = await stage(value, item, index);
        } catch {
          return null;
        }
      }
      return value;
    }),
  );
}

// ---------------------------------------------------------------------------
// log()
// ---------------------------------------------------------------------------

/** Emit a progress line: appended to the run's flow.log and streamed to watchers. */
export function log(msg: string): void {
  const ctx = ctxALS.getStore();
  if (ctx) {
    try {
      fs.appendFileSync(
        path.join(ctx.runDir, 'flow.log'),
        `${JSON.stringify({ at: new Date().toISOString(), message: msg })}\n`,
        'utf8',
      );
    } catch {
      // Best-effort log line.
    }
  }
  if (ctx?.hooks.onLog) {
    ctx.hooks.onLog(msg, currentDepth());
  } else if (process.stderr.isTTY || !ctx) {
    process.stderr.write(`[flow] ${msg}\n`);
  }
}

// ---------------------------------------------------------------------------
// Module loading
// ---------------------------------------------------------------------------

const require_ = createRequire(import.meta.url);

// A flow file lives in the user's repo, which has no @wular/coder or zod
// installed. Map those bare specifiers to coder's own shipped copies; every
// other specifier passes through so the flow's relative imports and its repo's
// node_modules still resolve.
// Locate a file under coder's shipped dist/, regardless of which bundle this
// module got inlined into (dist/cli.js, dist/flow/index.js, or dist/sdk.js).
function coderDistFile(rel: string): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (path.basename(dir) !== 'dist' && path.dirname(dir) !== dir) {
    dir = path.dirname(dir);
  }
  return path.basename(dir) === 'dist' ? pathToFileURL(path.join(dir, rel)).href : null;
}

function coderSpecifierUrl(spec: string): string | null {
  const known =
    spec === '@wular/coder' ||
    spec === '@wular/coder/flow' ||
    spec === 'zod' ||
    spec.startsWith('zod/');
  if (!known) return null;
  // Self-reference / dependency resolution against coder's package context.
  try {
    return pathToFileURL(require_.resolve(spec)).href;
  } catch {
    // Fall back to the fixed dist layout for coder's own subpaths.
  }
  if (spec === '@wular/coder/flow') return coderDistFile('flow/index.js');
  if (spec === '@wular/coder') return coderDistFile('sdk.js');
  return null;
}

// Matches the specifier in `import ... from 'x'`, `import 'x'`, and `import('x')`.
const IMPORT_RE = /(\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)(['"])([^'"]+)\2/g;

function rewriteSpecifiers(source: string): string {
  return source.replace(IMPORT_RE, (match, pre, quote, spec) => {
    const url = coderSpecifierUrl(spec);
    return url ? `${pre}${quote}${url}${quote}` : match;
  });
}

async function importResolved(fileToImport: string, ext: string, origName: string): Promise<any> {
  try {
    return await import(pathToFileURL(fileToImport).href);
  } catch (e) {
    // Only blame TS when a .ts file genuinely failed to parse under a
    // non-TS runtime; leave other import errors (real bugs) untouched.
    const msg = e instanceof Error ? e.message : String(e);
    const looksLikeTsParse =
      ext === '.ts' &&
      !(process as any).versions?.bun &&
      /Unknown file extension|Unexpected token|SyntaxError|Cannot parse|import type|interface/i.test(msg);
    if (looksLikeTsParse) {
      throw new Error(
        `Could not run ${path.basename(origName)}: TypeScript flows need bun. Run under \`bun\`, or write the flow as .mjs/.js.`,
      );
    }
    throw e;
  }
}

// Rewrite coder/zod specifiers to shipped copies. When a rewrite is needed we
// import a temp sibling (same dir, so relative imports still resolve) and clean
// it up; otherwise the original file is imported untouched.
async function importFlow(filePath: string): Promise<any> {
  const ext = path.extname(filePath);
  let source: string;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new Error(`Cannot read flow file: ${filePath}`);
  }
  const rewritten = rewriteSpecifiers(source);
  if (rewritten === source) {
    return importResolved(filePath, ext, filePath);
  }
  // A crash between write and the finally-unlink leaves the temp module
  // behind in the user's dir — sweep stale ones (old enough that no live
  // import can still be racing on them) before adding another.
  const dir = path.dirname(filePath);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('.__coderflow_')) continue;
      const stale = path.join(dir, name);
      if (Date.now() - fs.statSync(stale).mtimeMs > 10 * 60_000) fs.unlinkSync(stale);
    }
  } catch {
    // Best-effort sweep.
  }
  const tmp = path.join(
    dir,
    `.__coderflow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}${ext}`,
  );
  fs.writeFileSync(tmp, rewritten, 'utf8');
  try {
    return await importResolved(tmp, ext, filePath);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup.
    }
  }
}

async function loadAndRun(filePath: string, rawArgs: unknown): Promise<unknown> {
  const scope = scopeALS.getStore()!;
  scope.args = rawArgs ?? {};
  const mod = await importFlow(filePath);
  const schema = mod.args;
  let effective = scope.args;
  if (isZodLike(schema)) {
    const parsed = schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const v = validate(schema, rawArgs ?? {});
      throw new Error(`Invalid flow args: ${(v as any).errors ?? 'validation failed'}`);
    }
    effective = parsed.data;
    scope.args = effective;
  }
  const def = mod.default;
  if (typeof def === 'function') {
    return def(effective);
  }
  return def;
}

// ---------------------------------------------------------------------------
// flow() — inline sub-flow
// ---------------------------------------------------------------------------

/**
 * Run another flow inline as a sub-step and return its result. Nesting is one
 * level deep — a sub-flow cannot call `flow()` itself.
 */
export async function flow(name: string, args?: unknown): Promise<unknown> {
  const ctx = ctxALS.getStore();
  const cwd = ctx?.cwd ?? process.cwd();
  const resolved = resolveFlow(name, cwd);

  if (!ctx) {
    return scopeALS.run({ args: args ?? {}, depth: 0 }, () => loadAndRun(resolved.path, args));
  }

  const scope = scopeALS.getStore();
  if (scope && scope.depth >= 1) {
    throw new Error(`flow("${name}") nesting is one level deep; a sub-flow cannot call flow().`);
  }
  const fp = fingerprint('flow', { name: resolved.name, args: args ?? {} });
  const hit = ctx.journal.replay(fp);
  if (hit) return hit.result;

  const startedAt = new Date().toISOString();
  ctx.hooks.onFlowStart?.({ name: resolved.name, depth: (scope?.depth ?? 0) + 1 });
  const result = await scopeALS.run({ args: args ?? {}, depth: (scope?.depth ?? 0) + 1 }, () =>
    loadAndRun(resolved.path, args),
  );
  ctx.journal.record({ kind: 'flow', fingerprint: fp, result, startedAt, endedAt: new Date().toISOString() });
  return result;
}

// ---------------------------------------------------------------------------
// Run store
// ---------------------------------------------------------------------------

function generateRunId(): string {
  return `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function flowsStateDir(): string {
  return path.join(resolveCoderHome(), 'state', 'global', 'flows');
}

// Archived runs live in a sibling bin, so the default list only ever scans the
// (tiny) active bin — mirrors the jobs/archive split in lib/state.ts.
function flowsArchiveDir(): string {
  return path.join(resolveCoderHome(), 'state', 'global', 'flows-archived');
}

// Resolves to whichever bin holds the run (live wins); a fresh run id falls
// through to the live bin.
export function runDirFor(runId: string): string {
  assertValidId(runId, 'flow run id');
  const live = path.join(flowsStateDir(), runId);
  if (fs.existsSync(path.join(live, 'flow.json'))) return live;
  const archived = path.join(flowsArchiveDir(), runId);
  if (fs.existsSync(path.join(archived, 'flow.json'))) return archived;
  return live;
}

// Flag a run archived without moving its dir; listRuns/listArchivedRuns
// tolerate the flag-without-move interim and finish the move.
export function markRunArchived(record: FlowRecord): FlowRecord {
  if (record.archived) return record;
  const next: FlowRecord = { ...record, archived: true, archivedAt: new Date().toISOString() };
  writeFlowRecord(runDirFor(record.runId), next);
  return next;
}

// Archive a run fully: flag the record and move its dir into the archive bin.
// The run's tasks are ordinary tasks and are left alone.
export function archiveRun(record: FlowRecord): FlowRecord {
  const next = markRunArchived(record);
  const from = runDirFor(record.runId);
  const to = path.join(flowsArchiveDir(), record.runId);
  if (from !== to) {
    try {
      fs.mkdirSync(flowsArchiveDir(), { recursive: true });
      fs.renameSync(from, to);
    } catch {
      // Move failed (conflict, cross-device) — the record is still flagged
      // archived, so views stay correct; only the scan-cost win is lost.
    }
  }
  return next;
}

// Resuming an archived run makes it running again: move it back to the live
// bin and clear the flag.
export function unarchiveRun(record: FlowRecord): FlowRecord {
  const from = runDirFor(record.runId);
  const to = path.join(flowsStateDir(), record.runId);
  if (from !== to) {
    try {
      fs.mkdirSync(flowsStateDir(), { recursive: true });
      fs.renameSync(from, to);
    } catch {
      // Move failed — the flag still clears below, so it lists as recent.
    }
  }
  const next: FlowRecord = { ...record, archived: undefined, archivedAt: undefined };
  writeFlowRecord(runDirFor(record.runId), next);
  return next;
}

// Delete a run's dir (record, journal, events, logs) from either bin. The
// run's tasks are ordinary tasks and are not touched.
export function deleteRun(runId: string): boolean {
  const runDir = runDirFor(runId);
  if (!fs.existsSync(path.join(runDir, 'flow.json'))) return false;
  fs.rmSync(runDir, { recursive: true, force: true });
  return true;
}

export function readFlowRecord(runId: string): FlowRecord | null {
  // A lookup by user-supplied reference: a malformed id is just "not found".
  if (!isValidId(runId)) return null;
  const file = path.join(runDirFor(runId), 'flow.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as FlowRecord;
  } catch {
    return null;
  }
}

function writeFlowRecord(runDir: string, record: FlowRecord): void {
  fs.writeFileSync(path.join(runDir, 'flow.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function scanRuns(dir: string): FlowRecord[] {
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const runs: FlowRecord[] = [];
  for (const id of ids) {
    try {
      runs.push(JSON.parse(fs.readFileSync(path.join(dir, id, 'flow.json'), 'utf8')) as FlowRecord);
    } catch {
      // Not a run dir (or unreadable) — skip.
    }
  }
  return runs;
}

const byStart = (a: FlowRecord, b: FlowRecord) =>
  String(b.startedAt).localeCompare(String(a.startedAt));

/** Live runs newest-first (by startedAt); runs flagged archived in place migrate out. */
export function listRuns(): FlowRecord[] {
  const runs: FlowRecord[] = [];
  for (const r of scanRuns(flowsStateDir())) {
    if (r.archived) archiveRun(r);
    else runs.push(r);
  }
  return runs.sort(byStart);
}

/**
 * Archived runs. Scans the live bin too so flagged-in-place runs show up (and
 * migrate); migrate: false skips the dir moves for cheap counts on hot paths.
 */
export function listArchivedRuns(opts?: { migrate?: boolean }): FlowRecord[] {
  const migrate = opts?.migrate ?? true;
  const archived = scanRuns(flowsArchiveDir());
  const seen = new Set(archived.map(r => r.runId));
  for (const r of scanRuns(flowsStateDir())) {
    if (r.archived && !seen.has(r.runId)) {
      archived.push(migrate ? archiveRun(r) : r);
    }
  }
  return archived.sort(byStart);
}

export function latestRun(): FlowRecord | null {
  // Search live and archived alike (result/stream/resume accept archived
  // runs), newest first across both bins — mirrors findJob for tasks.
  return [...listRuns(), ...listArchivedRuns()].sort(byStart)[0] ?? null;
}

/**
 * A run's journal-derived step rows (SDK `flow.result` / `coder flow result`),
 * each task step with its current job status. `tail` keeps only the last n
 * ('all', the default, keeps every step; 0 none).
 */
export function flowSteps(runId: string, tail: number | 'all' = 'all'): FlowStep[] {
  if (tail === 0) return [];
  const tasks = readJournal(path.join(runDirFor(runId), 'journal.jsonl')).filter(
    e => e.kind === 'task',
  );
  const jobs = listJobs(process.cwd());
  const byId = new Map(jobs.map(j => [j.id, j]));
  // Display name: the task's name, else the prompt's opening line as-is (the
  // same fallback the task lists use).
  const displayName = (job?: { name?: string | null; prompt?: string }) =>
    job?.name ?? job?.prompt?.replace(/\s+/g, ' ').trim().slice(0, 60) ?? null;
  const steps: FlowStep[] = tasks.map(e => {
    const job = e.taskId ? byId.get(e.taskId) : undefined;
    return {
      taskId: e.taskId ?? null,
      name: displayName(job),
      status: job?.status ?? (e.result as { status?: string } | null)?.status ?? '?',
      tokens: e.tokens ?? null,
    };
  });
  // A task that threw (failed dispatch, stopped mid-run) never reaches the
  // journal; pick those up from the run-tagged jobs so no step goes missing.
  const seen = new Set(steps.map(st => st.taskId));
  for (const job of jobs) {
    if (job.flowRunId === runId && !seen.has(job.id)) {
      steps.push({ taskId: job.id, name: displayName(job), status: job.status, tokens: null });
    }
  }
  return tail === 'all' ? steps : steps.slice(-tail);
}

/**
 * Runs for `coder flow list`: running runs always, terminal ones that ended
 * inside the archive window; `archived` lists the archived bin instead.
 */
export function collectFlowRuns(
  opts: { archived?: boolean; limit?: number } = {},
): { runs: FlowRecord[]; clipped: number } {
  let runs: FlowRecord[];
  if (opts.archived) {
    runs = listArchivedRuns();
  } else {
    // Auto-archive sweep: any terminal run older than AUTO_ARCHIVE_MS drops
    // out of the default view. Flag it archived inline (cheap, keeps the
    // record correct) but defer the slow dir move to a detached sweep.
    const toArchive: string[] = [];
    runs = listRuns().filter(r => {
      if (r.status === 'running' || r.status === 'queued') return true;
      if (ageMs(r.endedAt ?? r.startedAt) <= AUTO_ARCHIVE_MS) return true;
      markRunArchived(r);
      toArchive.push(r.runId);
      return false;
    });
    spawnArchiveSweep(process.cwd(), toArchive, { flows: true });
  }
  const clipped = opts.limit !== undefined ? Math.max(0, runs.length - opts.limit) : 0;
  return { runs: opts.limit !== undefined ? runs.slice(0, opts.limit) : runs, clipped };
}

// ---------------------------------------------------------------------------
// executeRun — the journaled orchestrator (CLI + SDK)
// ---------------------------------------------------------------------------

export interface RunOptions {
  args?: unknown;
  concurrency?: number;
  maxTasks?: number;
  dryRun?: boolean;
  cwd?: string;
}

export interface RunSummary {
  runId: string;
  name: string;
  status: 'completed';
  result: unknown;
  tokens: Record<string, TokenUsage>;
  taskCount: number;
}

interface StartedRun {
  runId: string;
  runDir: string;
  ctx: RunContext;
  markStopped: () => void;
}

/**
 * Resolve the flow and write flow.json with status running — the run record a
 * detached orchestrator (or beginRun below) attaches to.
 */
export function prepareRun(ref: string, opts: RunOptions = {}, resumeRunId?: string): FlowRecord {
  let name: string;
  let script: string;
  let args: unknown;

  if (resumeRunId) {
    const prior = readFlowRecord(resumeRunId);
    if (!prior) throw new Error(`No flow run "${resumeRunId}".`);
    // An archived run becomes running again: move it back to the live bin.
    if (prior.archived) unarchiveRun(prior);
    name = prior.name;
    script = prior.script;
    args = opts.args ?? prior.args;
  } else {
    const resolved = resolveFlow(ref, opts.cwd ? path.resolve(opts.cwd) : process.cwd());
    name = resolved.name;
    script = resolved.path;
    args = opts.args ?? {};
  }

  const runId = resumeRunId ?? generateRunId();
  const runDir = runDirFor(runId);
  fs.mkdirSync(runDir, { recursive: true });

  const record: FlowRecord = {
    runId,
    name,
    script,
    args,
    status: 'running',
    startedAt: new Date().toISOString(),
    concurrency: Math.max(1, opts.concurrency ?? os.cpus().length),
    maxTasks: Math.max(1, opts.maxTasks ?? os.cpus().length * 10),
    taskCount: 0,
    ledger: {},
  };
  writeFlowRecord(runDir, record);
  return record;
}

// Terminal write: stamp endedAt and clear the orchestrator pid.
function endRecord(runDir: string, record: FlowRecord, patch: Partial<FlowRecord>): void {
  writeFlowRecord(runDir, {
    ...record,
    endedAt: new Date().toISOString(),
    pid: undefined,
    pidStartedAt: undefined,
    ...patch,
  });
}

/** Stamp a still-running record failed — a detached orchestrator that crashed before drive(). */
export function markRunFailed(runId: string, error: string): void {
  const record = readFlowRecord(runId);
  if (!record || record.status !== 'running') return;
  endRecord(runDirFor(runId), record, { status: 'failed', error });
}

// ---------------------------------------------------------------------------
// stopRun — signal a running orchestrator and reconcile (CLI + SDK)
// ---------------------------------------------------------------------------

/** Written by `flow stop --keep-tasks` before signalling; the SIGINT handler skips task stops when present. */
export const STOP_KEEP_TASKS_MARKER = 'stop-keep-tasks';

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Liveness with a recycled-pid guard: a live pid whose process started well
// after the record stamped it is NOT our orchestrator (the real one died and
// the OS reused the number) — mirrors pidIsOurWorker for task workers.
function orchestratorAlive(record: FlowRecord): boolean {
  if (!record.pid || !pidAlive(record.pid)) return false;
  const started = processStartMs(record.pid);
  const recorded = Date.parse(record.pidStartedAt ?? '');
  if (started === null || !Number.isFinite(recorded)) {
    return true; // can't verify start time — trust liveness
  }
  return started <= recorded + 60_000;
}

// A run's non-terminal task ids: journal entries plus jobs tagged with the run id.
function runningTaskIdsFor(runId: string): string[] {
  const jobs = listJobs(process.cwd());
  const byId = new Map(jobs.map(j => [j.id, j]));
  const ids = new Set<string>(jobs.filter(j => j.flowRunId === runId).map(j => j.id));
  for (const e of readJournal(path.join(runDirFor(runId), 'journal.jsonl'))) {
    if (e.kind === 'task' && e.taskId) ids.add(e.taskId);
  }
  return [...ids].filter(id => {
    const job = byId.get(id);
    return !!job && !TERMINAL_STATUSES.includes(job.status);
  });
}

/** Stop every non-terminal task of a run via the task-stop core. Print-free. */
export async function stopFlowTasks(runId: string, extraIds: string[] = []): Promise<string[]> {
  const cwd = process.cwd();
  const stopped: string[] = [];
  for (const id of new Set([...runningTaskIdsFor(runId), ...extraIds])) {
    const job = readJob(cwd, id);
    if (!job || TERMINAL_STATUSES.includes(job.status)) continue;
    try {
      await stopTaskCore(cwd, job);
      stopped.push(id);
    } catch {
      // Task already gone.
    }
  }
  return stopped;
}

export interface StopSummary {
  runId: string;
  status: FlowRecord['status'];
  stoppedTasks: string[];
  keptTasks: string[];
}

/**
 * Stop a running flow: verify the orchestrator pid is alive, SIGINT it, and
 * wait for the record to leave 'running'. A dead pid on a running record is
 * reconciled to failed (nothing chose to stop it) without signalling anything.
 */
export async function stopRun(
  runId?: string,
  opts: { keepTasks?: boolean } = {},
): Promise<StopSummary> {
  const record = runId ? readFlowRecord(runId) : latestRun();
  if (!record) {
    throw new CoderError('flow-failed', runId ? `No flow run "${runId}".` : 'No flow runs.', {
      hint: 'Run one: coder flow run <name>',
    });
  }
  if (record.status !== 'running') {
    throw new CoderError('flow-failed', `Run ${record.runId} is not running.`, {
      runId: record.runId,
      hint: `Result: coder flow result ${record.runId}`,
    });
  }
  const runDir = runDirFor(record.runId);
  if (!orchestratorAlive(record)) {
    endRecord(runDir, record, { status: 'failed', error: 'orchestrator died' });
    return {
      runId: record.runId,
      status: 'failed',
      stoppedTasks: [],
      keptTasks: runningTaskIdsFor(record.runId),
    };
  }

  const candidates = runningTaskIdsFor(record.runId);
  const marker = path.join(runDir, STOP_KEEP_TASKS_MARKER);
  if (opts.keepTasks) fs.writeFileSync(marker, '', 'utf8');
  try {
    process.kill(record.pid!, 'SIGINT');
    // The handler stops tasks first, then stamps a terminal status; poll for it.
    let current = readFlowRecord(record.runId);
    for (let i = 0; i < 25 && current?.status === 'running'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
      current = readFlowRecord(record.runId);
    }
    if (!current || current.status === 'running') {
      throw new CoderError('flow-failed', `Run ${record.runId} did not stop within 5s.`, {
        runId: record.runId,
        hint: `Check it: coder flow result ${record.runId}`,
      });
    }
    // Classify by what actually happened: cancelled means the handler stopped
    // it; still-running means kept; finished on its own is neither.
    const cwd = process.cwd();
    const stoppedTasks: string[] = [];
    const keptTasks: string[] = [];
    for (const id of candidates) {
      const job = readJob(cwd, id);
      if (!job) continue;
      if (job.status === 'cancelled') stoppedTasks.push(id);
      else if (!TERMINAL_STATUSES.includes(job.status)) keptTasks.push(id);
    }
    return { runId: record.runId, status: current.status, stoppedTasks, keptTasks };
  } finally {
    if (opts.keepTasks) {
      try {
        fs.unlinkSync(marker);
      } catch {
        // Already consumed.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// streamFlowCore — follow a run's event stream (CLI + SDK)
// ---------------------------------------------------------------------------

/**
 * Print-free follower (SDK `flow.stream`): replay the run's events.jsonl from
 * the start, tail it at 400ms, and end once the run leaves 'running'. A dead
 * orchestrator pid on a still-running record is reconciled to failed; the
 * caller reads the record afterwards for the summary. `bootPid` is the spawned
 * child's pid, checked until the orchestrator records its own. `tail` replays
 * only the last n events already logged (default 'all').
 */
export async function* streamFlowCore(
  runId: string,
  bootPid?: number,
  opts: { tail?: number | 'all' } = {},
): AsyncGenerator<FlowEvent> {
  const eventsFile = path.join(runDirFor(runId), 'events.jsonl');
  // Skip everything older than the last `tail` events.
  const tail = opts.tail ?? 'all';
  let emitted = 0;
  if (tail !== 'all') {
    try {
      emitted = Math.max(0, fs.readFileSync(eventsFile, 'utf8').split('\n').length - 1 - tail);
    } catch {
      // No stream yet.
    }
  }
  // Incremental tail: each tick reads only the appended bytes (a follower on
  // a chatty run would otherwise re-parse the whole stream every 400ms).
  const tailLines = createJsonlTail(eventsFile);
  const drain = (): FlowEvent[] => {
    const fresh: FlowEvent[] = [];
    for (const line of tailLines()) {
      // `emitted` skips the pre-counted head when a numeric tail was asked for.
      if (emitted > 0) {
        emitted -= 1;
        continue;
      }
      try {
        fresh.push(JSON.parse(line) as FlowEvent);
      } catch {
        // Skip a malformed line.
      }
    }
    return fresh;
  };

  let record = readFlowRecord(runId);
  while (!record || record.status === 'running') {
    yield* drain();
    // The run dying without a terminal write: pid dead (boot pid until the
    // orchestrator records its own) on a still-running record.
    // Prefer the record's own pid (with the recycled-pid guard); the boot pid
    // only bridges the gap before the orchestrator records itself.
    const dead = record?.pid
      ? !orchestratorAlive(record)
      : bootPid !== undefined && !pidAlive(bootPid);
    if (record && (record.pid || bootPid !== undefined) && dead) {
      markRunFailed(runId, 'orchestrator died');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 400));
    record = readFlowRecord(runId) ?? record;
  }
  yield* drain();
}

// Build the context and flow.json for a fresh or resumed run.
function beginRun(ref: string, opts: RunOptions, hooks: FlowHooks, resumeRunId?: string): {
  started: StartedRun;
  args: unknown;
  name: string;
  replayable: number;
} {
  // This process is the one driving the run: record its pid for `flow stop`.
  const record: FlowRecord = {
    ...prepareRun(ref, opts, resumeRunId),
    pid: process.pid,
    pidStartedAt: new Date().toISOString(),
  };
  const { runId } = record;
  const runDir = runDirFor(runId);
  writeFlowRecord(runDir, record);

  const journalFile = path.join(runDir, 'journal.jsonl');
  const recorded = resumeRunId ? readJournal(journalFile) : [];
  const journal = new Journal(recorded, journalFile);

  const ctx: RunContext = {
    runId,
    runDir,
    cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd(),
    journal,
    semaphore: new Semaphore(record.concurrency),
    maxTasks: record.maxTasks,
    dryRun: opts.dryRun ?? false,
    ledger: {},
    running: new Set(),
    taskCount: 0,
    stopping: false,
    hooks,
  };

  const markStopped = () => {
    ctx.stopping = true;
    endRecord(runDir, record, { status: 'stopped', taskCount: ctx.taskCount, ledger: ctx.ledger });
  };

  return {
    started: { runId, runDir, ctx, markStopped },
    args: record.args,
    name: record.name,
    replayable: recorded.length,
  };
}

async function drive(started: StartedRun, script: string, name: string, args: unknown): Promise<RunSummary> {
  const { ctx, runDir, runId } = started;
  const base = readFlowRecord(runId)!;
  try {
    const result = await ctxALS.run(ctx, () =>
      scopeALS.run({ args: args ?? {}, depth: 0 }, () => loadAndRun(script, args)),
    );
    endRecord(runDir, base, {
      status: 'completed',
      taskCount: ctx.taskCount,
      ledger: ctx.ledger,
      result,
    });
    return { runId, name, status: 'completed', result, tokens: ctx.ledger, taskCount: ctx.taskCount };
  } catch (e) {
    if (!ctx.stopping) {
      endRecord(runDir, base, {
        status: 'failed',
        taskCount: ctx.taskCount,
        ledger: ctx.ledger,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    throw new CoderError('flow-failed', e instanceof Error ? e.message : String(e), { runId });
  }
}

/**
 * Foreground orchestrator. `hooks.onStart` receives a stop handle so a CLI can
 * install a SIGINT handler; the event hooks feed live progress rendering.
 * The SDK omits them all.
 */
export async function runFlow(
  ref: string,
  opts: RunOptions = {},
  hooks: FlowHooks = {},
): Promise<RunSummary> {
  const { started } = beginRun(ref, opts, hooks);
  const script = readFlowRecord(started.runId)!.script;
  hooks.onStart?.({
    runId: started.runId,
    requestStop: started.markStopped,
    runningIds: () => [...started.ctx.running],
  });
  return drive(started, script, readFlowRecord(started.runId)!.name, opts.args ?? {});
}

export async function resumeFlow(
  runId: string,
  opts: RunOptions = {},
  hooks: FlowHooks = {},
): Promise<RunSummary> {
  const { started, args, name, replayable } = beginRun('', opts, hooks, runId);
  const script = readFlowRecord(runId)!.script;
  hooks.onStart?.({
    runId,
    requestStop: started.markStopped,
    runningIds: () => [...started.ctx.running],
  });
  if (replayable) hooks.onReplay?.(replayable);
  return drive(started, script, name, args);
}
