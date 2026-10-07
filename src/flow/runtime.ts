/** Flow runtime: ALS context, primitives, and the run executor. See docs/flows.md. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CoderError,
  capPermissions,
  dispatchTask,
  turnFallbackEngine,
  waitTask,
} from '../core/dispatch';
import { mailboxDir, askWorker } from '../core/mailbox';
import { formatEngineSpec, loadTask } from '../core/state';
import type { TokenUsage, TurnResult } from '../core/types';
import { Journal, defined, fingerprint } from './journal';
import { resolveFlow } from './discover';
import type { FlowSchema, FlowTaskOptions, FlowTaskResult, GateResult } from './types';
import { readFlowRecord, writeFlowRecord } from './runs';

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
    engine?: string;
    depth?: number;
  }) => void;
  /** A task reached a terminal state. */
  onTaskEnd?: (info: { taskId: string; status: string; tokens: TokenUsage | null }) => void;
  /** A gate command was spawned (real runs only, never dry-run or replay). */
  onGateStart?: (info: { gateId: string; cmd: string; depth?: number }) => void;
  /** A gate command finished; `gateId` pairs it with its onGateStart. */
  onGate?: (info: {
    gateId?: string;
    cmd: string;
    ok: boolean;
    code: number;
    depth?: number;
  }) => void;
  /** The flow called log(). */
  onLog?: (msg: string, depth?: number) => void;
  /** A sub-flow started (depth is the sub-flow's own nesting level). */
  onFlowStart?: (info: { name: string; depth: number }) => void;
  /** A resume replayed recorded steps from the journal. */
  onReplay?: (count: number) => void;
}

export interface RunContext {
  runId: string;
  runDir: string;
  cwd: string;
  journal: Journal;
  semaphore: Semaphore;
  /** The caller set no concurrency, so the flow's own `concurrency` export applies. */
  flowConcurrency: boolean;
  maxTasks: number;
  dryRun: boolean;
  ledger: Record<string, TokenUsage>;
  running: Set<string>;
  taskCount: number;
  stopping: boolean;
  hooks: FlowHooks;
  /** Caller-owned platform credential; in memory only, never written to flow.json. */
  integrationToken?: string;
  ceiling?: { agent: string; permissions: string };
}

interface Scope {
  args: unknown;
  depth: number;
  imports?: { dirs: Set<string>; node: boolean };
}

// Anchored on globalThis: the CLI bundle and the `@wular/coder/flow` bundle each
// carry their own copy of this module, but a flow author's primitives must read
// the very context the CLI set. Sharing the ALS instances across both copies is
// what makes journaling, concurrency, and args work end to end.
const G = globalThis as unknown as {
  __coderFlowCtxALS?: AsyncLocalStorage<RunContext>;
  __coderFlowScopeALS?: AsyncLocalStorage<Scope>;
};
export const ctxALS = (G.__coderFlowCtxALS ??= new AsyncLocalStorage<RunContext>());
export const scopeALS = (G.__coderFlowScopeALS ??= new AsyncLocalStorage<Scope>());

export function currentScopeArgs(): unknown {
  return scopeALS.getStore()?.args;
}

/** Transient platform credential supplied by an agent task. */
export function currentIntegrationToken(): string | undefined {
  return ctxALS.getStore()?.integrationToken;
}

// Nesting level of the currently executing flow scope (0 = top-level).
function currentDepth(): number {
  return scopeALS.getStore()?.depth ?? 0;
}

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(public limit: number) {}
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

async function toJSONSchema(schema: unknown): Promise<object | null> {
  try {
    const zod = (await import('zod')) as any;
    if (typeof zod.toJSONSchema === 'function') {
      return zod.toJSONSchema(schema);
    }
  } catch {
    // Zod is unavailable or the schema is not convertible. Use generic prose.
  }
  return null;
}

async function formatInstructions(schema: unknown): Promise<string> {
  const json = await toJSONSchema(schema);
  const shape = json
    ? `matching this JSON Schema:\n${JSON.stringify(json, null, 2)}`
    : 'matching the requested shape';
  return `Reply with only a single JSON object ${shape}\nUse no prose or markdown fences. Return only the JSON object.`;
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

function validate(
  schema: unknown,
  value: unknown,
): { ok: true; data: unknown } | { ok: false; errors: string } {
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
    engine: opts.engine,
    model: opts.model,
    effort: opts.effort,
    permissions: ctx?.ceiling
      ? capPermissions(opts.name, opts.permissions, ctx.ceiling)
      : opts.permissions,
    name: opts.name,
    system: opts.system,
    addDirs: opts.addDirs,
    wait: true,
    flowRunId: ctx?.runId,
  };
}

async function runOneTask(
  prompt: string,
  opts: FlowTaskOptions,
  ctx: RunContext | undefined,
  resume?: string,
): Promise<{
  taskId: string;
  status: string;
  output: string;
  tokens: TokenUsage | null;
  model: string | null;
}> {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : (ctx?.cwd ?? process.cwd());
  const outputSchema = opts.returns ? await toJSONSchema(opts.returns) : null;
  const system =
    opts.returns && !outputSchema
      ? [opts.system, await formatInstructions(opts.returns)].filter(Boolean).join('\n\n')
      : opts.system;
  // Chain engine override for mid-turn fallback attempts; mirrors dispatch's
  // own startup fallback (next engine runs on its config defaults).
  let chainEngine: string | undefined;
  for (;;) {
    const request = {
      prompt,
      ...dispatchOptsFrom(opts, cwd, ctx),
      system,
      ...(outputSchema ? { outputSchema } : {}),
      ...(chainEngine
        ? { engine: chainEngine, model: undefined, effort: undefined, resume: undefined }
        : { resume: resume ?? opts.resume }),
    };
    // Inside an agent's sandbox the worker starts the task; here it only asks.
    const mailbox = Boolean(mailboxDir());
    const dispatch = mailbox
      ? await askWorker<{ taskId: string }>('dispatch', request)
      : await dispatchTask({
          ...request,
          // Surface the gate's silent chain walk. Otherwise the user stares at
          // nothing for the failed engine's whole startup window.
          onFallback: f =>
            log(
              `${f.engine} failed to start. Falling back to ${f.next}. ${f.detail.replace(/\s+/g, ' ').slice(0, 140)}`,
            ),
        });
    ctx?.running.add(dispatch.taskId);
    // Resolved engine spec ("claude/opus/medium") from the task record. The
    // dispatch may have picked the engine via the chain, not the flow author.
    const task = loadTask(cwd, dispatch.taskId);
    const engine = task ? formatEngineSpec(task) : undefined;
    ctx?.hooks.onTaskStart?.({
      taskId: dispatch.taskId,
      name: opts.name,
      prompt,
      engine,
      depth: currentDepth(),
    });
    let waited: WorkerWait;
    try {
      if (mailbox) {
        waited = await askWorker<WorkerWait>('wait', { taskId: dispatch.taskId });
      } else {
        const done = await waitTask(cwd, dispatch.taskId);
        waited = {
          status: done.status,
          result: done.result,
          model: done.task.model ?? null,
          next: turnFallbackEngine(cwd, done) ?? null,
        };
      }
    } finally {
      ctx?.running.delete(dispatch.taskId);
    }

    if (waited.next) {
      const next = waited.next;
      ctx?.hooks.onTaskEnd?.({ taskId: dispatch.taskId, status: 'failed', tokens: null });
      chainEngine = next;
      continue;
    }

    return {
      taskId: dispatch.taskId,
      status: waited.status,
      output: waited.result?.finalMessage || waited.result?.error?.message || '',
      tokens: waited.result?.tokens ?? null,
      model: waited.result?.model ?? waited.model,
    };
  }
}

/** What the worker answers a mailbox wait with; local waits take the same shape. */
interface WorkerWait {
  status: string;
  result: TurnResult | null;
  model: string | null;
  next: string | null;
}

async function executeTask(
  prompt: string,
  opts: FlowTaskOptions,
  ctx?: RunContext,
): Promise<FlowTaskResult> {
  if (ctx?.dryRun) {
    process.stdout.write(`\n[dry-run] task${opts.name ? ` (${opts.name})` : ''}:\n${prompt}\n`);
    const shown = { ...opts, returns: opts.returns ? '<schema>' : undefined };
    process.stdout.write(`[dry-run] opts: ${JSON.stringify(shown)}\n`);
    return {
      taskId: 'dry',
      status: 'completed',
      output: '[dry-run]',
      data: undefined,
      tokens: null,
      model: opts.model ?? null,
    };
  }

  const first = await runOneTask(prompt, opts, ctx);
  if (first.status !== 'completed') {
    const result: FlowTaskResult = { ...first, data: undefined };
    throw new CoderError(
      'task-failed',
      `Task ${first.taskId} ${first.status}: ${first.output || 'no output'}`,
      { taskId: first.taskId, result },
    );
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
      const retryPrompt = `Your previous reply did not match the required format: ${parsed.errors}\n\nReply again with the required JSON object.`;
      const retry = await runOneTask(retryPrompt, opts, ctx, first.taskId);
      output = retry.output || output;
      tokens = addTokens(tokens, retry.tokens);
      try {
        const reparsed = validate(opts.returns, extractJson(output));
        if (!reparsed.ok) throw new Error(reparsed.errors);
        data = reparsed.data;
      } catch (e) {
        const result: FlowTaskResult = {
          taskId: first.taskId,
          status: 'completed',
          output,
          data: undefined,
          tokens,
          model: first.model,
        };
        throw new CoderError(
          'task-failed',
          `Task ${first.taskId} produced no valid structured output: ${e instanceof Error ? e.message : String(e)}`,
          { taskId: first.taskId, result },
        );
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
// instead of resolving). The overload spares callers a needless `?.`/`!`.
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
export async function task(prompt: string, opts?: FlowTaskOptions): Promise<FlowTaskResult>;
export async function task<T = unknown>(
  prompt: string,
  opts: FlowTaskOptions<T> = {},
): Promise<FlowTaskResult<T>> {
  const ctx = ctxALS.getStore();
  if (!ctx) {
    return executeTask(prompt, opts) as Promise<FlowTaskResult<T>>;
  }
  // `agent` is the engine's journal key from before the rename.
  const part = {
    prompt,
    agent: opts.engine,
    model: opts.model,
    effort: opts.effort,
    permissions: opts.permissions,
    name: opts.name,
    system: opts.system,
    resume: opts.resume,
    cwd: opts.cwd,
    ...(opts.addDirs?.length ? { addDirs: opts.addDirs } : {}),
    returns: await returnsPart(opts.returns),
  };
  const fp = fingerprint('task', defined(part));
  // Older journals hashed unset keys as null.
  const hit = ctx.journal.replay(fp, fingerprint('task', part));
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
    ctx.journal.record({
      kind: 'task',
      fingerprint: fp,
      result: res,
      taskId: res.taskId,
      tokens: res.tokens,
      startedAt,
      endedAt: new Date().toISOString(),
    });
    return res as FlowTaskResult<T>;
  });
}

// ---------------------------------------------------------------------------
// gate()
// ---------------------------------------------------------------------------

// Captured gate output is journaled and kept in memory. Cap it so a chatty
// command (a full build log) can't balloon the journal or the process heap.
const GATE_OUTPUT_CAP = 256 * 1024;

// Like `bun run`, put every ancestor node_modules/.bin on PATH so gates can
// call locally installed binaries (`tsc`, `eslint`) without a runner prefix.
function gateEnv(cwd: string): NodeJS.ProcessEnv {
  const bins: string[] = [];
  for (let dir = cwd; ;) {
    bins.push(path.join(dir, 'node_modules', '.bin'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const sep = process.platform === 'win32' ? ';' : ':';
  return { ...process.env, PATH: [...bins, process.env.PATH ?? ''].join(sep) };
}

async function executeGate(cmd: string, cwd: string): Promise<GateResult> {
  return new Promise(resolve => {
    const child = spawn(cmd, { shell: true, cwd, env: gateEnv(cwd) });
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
    child.on('error', err =>
      resolve({ ok: false, code: 1, output: String(err.message ?? err).trim() }),
    );
    child.on('close', code => resolve({ ok: code === 0, code: code ?? 0, output: out.trim() }));
  });
}

/**
 * Run a shell command as a checkpoint. Never throws. Inspect `ok`/`code`.
 * output is captured (capped) and journaled for resume.
 */
export async function gate(cmd: string, opts: { cwd?: string } = {}): Promise<GateResult> {
  const ctx = ctxALS.getStore();
  const cwd = opts.cwd ? path.resolve(opts.cwd) : (ctx?.cwd ?? process.cwd());
  if (!ctx) {
    return executeGate(cmd, cwd);
  }
  const fp = fingerprint('gate', { cmd, cwd: opts.cwd });
  const hit = ctx.journal.replay(fp);
  if (hit) return hit.result as GateResult;

  if (ctx.dryRun) {
    process.stdout.write(`\n[dry-run] gate: ${cmd}\n`);
    const res: GateResult = { ok: true, code: 0, output: '' };
    ctx.journal.record({
      kind: 'gate',
      fingerprint: fp,
      result: res,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });
    return res;
  }
  const startedAt = new Date().toISOString();
  // A gate can run for minutes (a test harness, a cold tsc); announce the spawn
  // so the renderer can hold a live row instead of painting nothing until it
  // returns. Pid-prefixed so ids stay unique when a resume appends to the same
  // events.jsonl.
  const gateId = `gate-${process.pid}-${randomUUID()}`;
  const depth = currentDepth();
  ctx.hooks.onGateStart?.({ gateId, cmd, depth });
  const res = await executeGate(cmd, cwd);
  ctx.hooks.onGate?.({ gateId, cmd, ok: res.ok, code: res.code, depth });
  ctx.journal.record({
    kind: 'gate',
    fingerprint: fp,
    result: res,
    startedAt,
    endedAt: new Date().toISOString(),
  });
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
export async function pipeline<T, A, B>(
  items: T[],
  s1: S<T, T, A>,
  s2: S<A, T, B>,
): Promise<(B | null)[]>;
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

async function hookFlowImports(dir: string): Promise<void> {
  const scope = scopeALS.getStore()!;
  const imports = (scope.imports ??= { dirs: new Set(), node: false });
  if ((process as any).versions?.bun) {
    if (imports.dirs.has(dir)) return;
    imports.dirs.add(dir);
    const { plugin } = await import('bun');
    const root = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    plugin({
      name: `coder-flow:${dir}`,
      setup(build) {
        build.onLoad(
          { filter: new RegExp(`^${root}/(?!.*node_modules/).*\\.m?[jt]sx?$`) },
          args => ({
            contents: rewriteSpecifiers(fs.readFileSync(args.path, 'utf8')),
            loader: path.extname(args.path).replace(/^\.m?/, '') as 'js' | 'jsx' | 'ts' | 'tsx',
          }),
        );
      },
    });
    return;
  }
  if (imports.node) return;
  imports.node = true;
  const { register } = await import('node:module');
  const urls = Object.fromEntries(
    ['@wular/coder', '@wular/coder/flow', 'zod'].flatMap(spec => {
      const url = coderSpecifierUrl(spec);
      return url ? [[spec, url]] : [];
    }),
  );
  const hooks = `const urls = ${JSON.stringify(urls)}, parent = ${JSON.stringify(import.meta.url)};
export function resolve(spec, ctx, next) {
  if (urls[spec]) return { url: urls[spec], shortCircuit: true };
  return next(spec, spec.startsWith('zod/') ? { ...ctx, parentURL: parent } : ctx);
}`;
  register(`data:text/javascript,${encodeURIComponent(hooks)}`);
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
      /Unknown file extension|Unexpected token|SyntaxError|Cannot parse|import type|interface/i.test(
        msg,
      );
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
// it up; otherwise the original file is imported untouched. Inside an agent's
// sandbox the temp module goes in the mailbox, the one writable path.
async function importFlow(filePath: string): Promise<any> {
  if (!fs.existsSync(filePath)) throw new Error(`Cannot read flow file: ${filePath}`);
  await hookFlowImports(path.dirname(filePath));
  return importResolved(filePath, path.extname(filePath), filePath);
}

export async function loadAndRun(filePath: string, rawArgs: unknown): Promise<unknown> {
  const scope = scopeALS.getStore()!;
  scope.args = rawArgs ?? {};
  const mod = await importFlow(filePath);
  const ctx = ctxALS.getStore();
  if (ctx?.flowConcurrency && !scope.depth && typeof mod.concurrency === 'number') {
    ctx.semaphore.limit = Math.max(1, mod.concurrency);
    writeFlowRecord(ctx.runDir, {
      ...readFlowRecord(ctx.runId)!,
      concurrency: ctx.semaphore.limit,
    });
  }
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
// flow() supports an inline subflow.
// ---------------------------------------------------------------------------

/**
 * Run another flow inline as a sub-step and return its result. Nesting is one
 * level deep. A subflow cannot call `flow()` itself.
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
  const result = await scopeALS.run(
    { args: args ?? {}, depth: (scope?.depth ?? 0) + 1, imports: scope?.imports },
    () => loadAndRun(resolved.path, args),
  );
  ctx.journal.record({
    kind: 'flow',
    fingerprint: fp,
    result,
    startedAt,
    endedAt: new Date().toISOString(),
  });
  return result;
}
