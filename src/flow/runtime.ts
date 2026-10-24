/** Flow runtime: ALS context, primitives, and the run executor. See docs/flows.md. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CoderError,
  dispatchTask,
  modelList,
  resolveTaskOptions,
  selectMcpServers,
  turnMayFallBack,
  waitTask,
} from '../core/dispatch';
import { formatEngineSpec, loadTask } from '../core/state';
import { steerTask } from '../core/task/actions';
import type { ReviewLinks } from '../core/task/review';
import type {
  Access,
  TokenUsage,
  TurnResult,
  McpServerSpec,
  ResolvedTaskOptions,
} from '../core/types';
import { addTokens } from '../core/task/view';
import { loadConfig, strictestAccess } from '../core/config';
import { jsonReplyPrompt, jsonRetryPrompt } from '../core/task/context/turn';
import { resolveFlow } from './discover';
import type {
  FlowSchema,
  FlowSteerOptions,
  FlowTaskOptions,
  FlowTaskResult,
  GateResult,
  FlowEvent,
  FlowRecord,
  JournalEntry,
} from './types';
import { writeFlowRecord } from './runs';

// ---------------------------------------------------------------------------
// Journal read/write + input fingerprinting. See docs/flows.md "Resume".
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/** A fingerprint payload without its unset keys, so a new option leaves old fingerprints alone. */
export function defined<T extends Record<string, unknown>>(payload: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(payload).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

export function fingerprint(kind: string, payload: unknown): string {
  return crypto
    .createHash('sha256')
    .update(`${kind}\0${stableStringify(payload)}`)
    .digest('hex');
}

export function readJournal(file: string): JournalEntry[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line) as JournalEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is JournalEntry => e !== null);
}

/**
 * Prefix-order replay. A call matches the first unconsumed recorded entry with
 * an identical fingerprint (fingerprint match rather than strict positional
 * next, so concurrent pipelines resume correctly); a miss runs live. The file
 * is truncated on construction and rewritten in this run's completion order, so
 * every run leaves a clean journal for the next resume.
 */
export class Journal {
  private recorded: (JournalEntry & { consumed?: boolean })[];
  private seq = 0;

  constructor(
    recorded: JournalEntry[],
    private file: string,
  ) {
    this.recorded = recorded.map(e => ({ ...e }));
    fs.writeFileSync(file, '', 'utf8');
  }

  private write(entry: JournalEntry): void {
    entry.seq = this.seq++;
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Recorded result for one of these fingerprints, or null to run live. */
  replay(...fps: string[]): JournalEntry | null {
    const hit = this.recorded.find(e => !e.consumed && fps.includes(e.fingerprint));
    if (!hit) {
      return null;
    }
    hit.consumed = true;
    const { consumed: _consumed, ...clean } = hit;
    this.write(clean as JournalEntry);
    return clean as JournalEntry;
  }

  record(entry: Omit<JournalEntry, 'seq'>): void {
    this.write({ ...entry, seq: 0 });
  }
}

// ---------------------------------------------------------------------------
// ALS: run services (ctx) and per-invocation scope (args + nesting depth)
// ---------------------------------------------------------------------------

/** Progress callbacks a foreground caller can attach to a run. */
export interface FlowHooks {
  /** Fired once the run is armed, with a stop handle for a SIGINT handler. */
  onStart?: (h: { runId: string; requestStop: () => void; runningIds: () => string[] }) => void;
  onEvent?: (event: FlowEvent) => void;
  /** A cloud runner's credentials for one model, best first; none skips the model. Unset runs on the process's own logins. */
  onModel?: (model: ResolvedTaskOptions) => Promise<NodeJS.ProcessEnv[]>;
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
  links?: ReviewLinks;
  connections?: { mcp: Record<string, McpServerSpec>; env: Record<string, string>; ids: string[] };
  access?: Access;
  /** The credential each of its tasks runs on, by task id, so a steer resumes on it. */
  credentialEnv?: Map<string, NodeJS.ProcessEnv>;
}

export function emitFlowEvent(ctx: RunContext | undefined, event: FlowEvent): void {
  if (!ctx) return;
  fs.appendFileSync(path.join(ctx.runDir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  ctx.hooks.onEvent?.(event);
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

export function currentReviewLinks(): ReviewLinks | undefined {
  return ctxALS.getStore()?.links;
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
    model: opts.model,
    mcp: opts.mcp,
    access: strictestAccess(opts.access, ctx?.access),
    name: opts.name,
    appendSystem: opts.appendSystem,
    addDirs: opts.addDirs,
    wait: true,
    flowRunId: ctx?.runId,
  };
}

type TurnOutcome = {
  taskId: string;
  status: string;
  output: string;
  tokens: TokenUsage | null;
  model: string | null;
};

function turnOutcome(taskId: string, waited: WorkerWait): TurnOutcome {
  return {
    taskId,
    status: waited.status,
    output: waited.result?.finalMessage || waited.result?.error?.message || '',
    tokens: waited.result?.tokens ?? null,
    model: waited.result?.model ?? waited.model,
  };
}

async function waitTurn(cwd: string, taskId: string, ctx?: RunContext): Promise<WorkerWait> {
  ctx?.running.add(taskId);
  try {
    const done = await waitTask(cwd, taskId);
    return {
      status: done.status,
      result: done.result,
      model: done.task.model ?? null,
      fallback: turnMayFallBack(cwd, done),
    };
  } finally {
    ctx?.running.delete(taskId);
  }
}

// One more turn on an existing task's thread, same id; another engine cannot continue it.
async function steerOnce(
  taskId: string,
  text: string,
  opts: FlowSteerOptions,
  ctx: RunContext | undefined,
): Promise<TurnOutcome> {
  const cwd = ctx?.cwd ?? process.cwd();
  const current = loadTask(cwd, taskId);
  if (!current) throw new CoderError('invalid-option', `No task "${taskId}".`);
  await steerTask(current.cwd ?? cwd, current, text, {
    ...(ctx?.connections
      ? {
          resolveConnections: async granted => ({
            mcp: Object.fromEntries(
              Object.entries(ctx.connections!.mcp).filter(([id]) => granted.includes(id)),
            ),
            env: ctx.connections!.env,
            warnings: [],
          }),
        }
      : {}),
    model: opts.model,
    access: opts.access,
    credentialEnv: ctx?.credentialEnv?.get(taskId),
  });
  return turnOutcome(taskId, await waitTurn(cwd, taskId, ctx));
}

async function runOneTask(
  prompt: string,
  opts: FlowTaskOptions,
  ctx: RunContext | undefined,
  outputSchema: object | null,
): Promise<TurnOutcome> {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : (ctx?.cwd ?? process.cwd());
  const appendSystem =
    opts.returns && !outputSchema
      ? [opts.appendSystem, jsonReplyPrompt(null)].filter(Boolean).join('\n\n')
      : opts.appendSystem;
  const config = loadConfig(cwd);
  const request = {
    prompt,
    ...dispatchOptsFrom(opts, cwd, ctx),
    appendSystem,
    ...(outputSchema ? { outputSchema } : {}),
    ...(opts.returns ? { structured: true } : {}),
  };
  const models = modelList(config, resolveTaskOptions(request, config));
  const selected = ctx?.connections
    ? selectMcpServers(request.mcp, config.mcp, {}, ctx.connections.mcp)
    : undefined;
  const started = (taskId: string) => {
    const task = loadTask(cwd, taskId);
    const engine = task ? formatEngineSpec(task) : undefined;
    emitFlowEvent(ctx, {
      kind: 'task-start',
      taskId: taskId,
      name: opts.name,
      prompt,
      engine,
      depth: currentDepth(),
    });
  };
  // Each model with each of its credentials, until a turn works or fails having done work.
  let failure: unknown;
  let outcome: TurnOutcome | undefined;
  for (const model of models) {
    const credentials = ctx?.hooks.onModel ? await ctx.hooks.onModel(model) : [undefined];
    if (!credentials.length) log(`${formatEngineSpec(model)} skipped: no credential runs it.`);
    for (const credentialEnv of credentials) {
      if (outcome) {
        emitFlowEvent(ctx, { kind: 'task-end', taskId: outcome.taskId, status: 'failed', tokens: null });
        log(`${outcome.model ?? 'The model'} failed. Trying ${formatEngineSpec(model)}.`);
      }
      let dispatch: Awaited<ReturnType<typeof dispatchTask>>;
      try {
        dispatch = await dispatchTask(
          {
            ...request,
            onWorker: started,
            ...(credentialEnv ? { credentialEnv } : {}),
            ...(ctx?.connections
              ? {
                  ...selected,
                  mcpWarnings: selected?.warnings,
                  connectionEnv: ctx.connections.env,
                  connections: ctx.connections.ids,
                  connectionSource: 'server' as const,
                }
              : {}),
          },
          { config, models: [model] },
        );
      } catch (error) {
        if (!(error instanceof CoderError) || error.code !== 'chain-exhausted') throw error;
        log(
          `${formatEngineSpec(model)} failed to start. ${error.message.replace(/\s+/g, ' ').slice(0, 140)}`,
        );
        failure = error;
        outcome = undefined;
        continue;
      }
      if (credentialEnv) (ctx!.credentialEnv ??= new Map()).set(dispatch.taskId, credentialEnv);
      const waited = await waitTurn(cwd, dispatch.taskId, ctx);
      outcome = turnOutcome(dispatch.taskId, waited);
      failure = undefined;
      if (!waited.fallback) return outcome;
    }
  }
  if (outcome) return outcome;
  throw failure ?? new CoderError('chain-exhausted', 'No credential runs any listed model.');
}

/** A task's turn as a flow waits for it. */
interface WorkerWait {
  status: string;
  result: TurnResult | null;
  model: string | null;
  /** The turn did no work and may run on the next credential or model. */
  fallback: boolean;
}

async function executeTask(
  prompt: string,
  opts: FlowTaskOptions,
  ctx?: RunContext,
  outputSchema: object | null = null,
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

  const first = await runOneTask(prompt, opts, ctx, outputSchema);
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
      const retry = await steerOnce(first.taskId, jsonRetryPrompt(parsed.errors), {}, ctx);
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

async function journaled(
  ctx: RunContext,
  fp: string,
  run: () => Promise<FlowTaskResult>,
): Promise<FlowTaskResult> {
  const hit = ctx.journal.replay(fp);
  if (hit) return hit.result as FlowTaskResult;
  if (++ctx.taskCount > ctx.maxTasks)
    throw new Error(
      `Flow exceeded --max-tasks (${ctx.maxTasks}). Raise it with --max-tasks, or fix a runaway loop; the run is resumable.`,
    );

  return ctx.semaphore.run(async () => {
    const startedAt = new Date().toISOString();
    let res: FlowTaskResult;
    try {
      res = await run();
    } catch (error) {
      const failed =
        error instanceof CoderError ? (error.result as FlowTaskResult | undefined) : undefined;
      if (failed)
        emitFlowEvent(ctx, {
          kind: 'task-end',
          taskId: failed.taskId,
          status: failed.status === 'completed' ? 'failed' : failed.status,
          tokens: failed.tokens,
        });
      throw error;
    }
    recordLedger(ctx, res);
    if (!ctx.dryRun)
      emitFlowEvent(ctx, {
        kind: 'task-end',
        taskId: res.taskId,
        status: res.status,
        tokens: res.tokens,
      });
    ctx.journal.record({
      kind: 'task',
      fingerprint: fp,
      result: res,
      taskId: res.taskId,
      tokens: res.tokens,
      startedAt,
      endedAt: new Date().toISOString(),
    });

    return res;
  });
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
  const outputSchema = opts.returns ? await toJSONSchema(opts.returns) : null;
  const run = () => executeTask(prompt, opts, ctx, outputSchema);
  if (!ctx) return run() as Promise<FlowTaskResult<T>>;
  const { returns, ...options } = opts;
  const fp = fingerprint(
    'task',
    defined({ prompt, ...options, returns: returns ? (outputSchema ?? '<schema>') : undefined }),
  );

  return journaled(ctx, fp, run) as Promise<FlowTaskResult<T>>;
}

/** Continue a task this run started, on the same id, and await the turn. Mirrors `coder task steer --wait`. */
export async function steer(
  taskId: string,
  text: string,
  opts: FlowSteerOptions = {},
): Promise<FlowTaskResult> {
  const ctx = ctxALS.getStore();
  const run = async () => {
    if (ctx?.dryRun) {
      process.stdout.write(`\n[dry-run] steer ${taskId}:\n${text}\n`);
      return {
        taskId,
        status: 'completed',
        output: '[dry-run]',
        tokens: null,
        model: opts.model ?? null,
      };
    }
    const turn = await steerOnce(taskId, text, opts, ctx);
    if (turn.status !== 'completed')
      throw new CoderError(
        'task-failed',
        `Task ${taskId} ${turn.status}: ${turn.output || 'no output'}`,
        { taskId, result: turn },
      );
    return turn;
  };
  if (!ctx) return run();

  return journaled(ctx, fingerprint('steer', defined({ taskId, text, ...opts })), run);
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
  emitFlowEvent(ctx, { kind: 'gate-start', gateId, cmd, depth });
  const res = await executeGate(cmd, cwd);
  emitFlowEvent(ctx, { kind: 'gate', gateId, cmd, ok: res.ok, code: res.code, depth });
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
      for (const [i, stage] of stages.entries()) {
        try {
          value = await stage(value, item, index);
        } catch (error) {
          log(`stage ${i + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
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

/** Emit a progress line to the run's event stream. */
export function log(msg: string): void {
  const ctx = ctxALS.getStore();
  emitFlowEvent(ctx, { kind: 'log', message: msg, depth: currentDepth() });
  if (!ctx || (process.stderr.isTTY && !ctx.hooks.onEvent)) process.stderr.write(`[flow] ${msg}\n`);
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
  if (spec === 'zod' || spec.startsWith('zod/')) {
    const bundled = coderDistFile('zod.js') ?? new URL('./zod.js', import.meta.url).href;
    if (fs.existsSync(fileURLToPath(bundled))) return bundled;
  }
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
  dir = fs.realpathSync(dir);
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
  if (spec.startsWith('zod/') && urls.zod) return { url: urls.zod, shortCircuit: true };
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

async function importFlow(filePath: string): Promise<any> {
  if (!fs.existsSync(filePath)) throw new Error(`Cannot read flow file: ${filePath}`);
  await hookFlowImports(path.dirname(filePath));
  return importResolved(filePath, path.extname(filePath), filePath);
}

export async function loadAndRun(
  filePath: string,
  rawArgs: unknown,
  record?: FlowRecord,
): Promise<unknown> {
  const scope = scopeALS.getStore()!;
  scope.args = rawArgs ?? {};
  const mod = await importFlow(filePath);
  const ctx = ctxALS.getStore();
  if (ctx?.flowConcurrency && !scope.depth && typeof mod.concurrency === 'number') {
    ctx.semaphore.limit = Math.max(1, mod.concurrency);
    if (record) {
      record.concurrency = ctx.semaphore.limit;
      writeFlowRecord(ctx.runDir, record);
    }
  }
  const schema = mod.args;
  let effective = scope.args;
  if (isZodLike(schema)) {
    const parsed = validate(schema, rawArgs ?? {});
    if (!parsed.ok) throw new Error(`Invalid flow args: ${parsed.errors}`);
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
  emitFlowEvent(ctx, { kind: 'flow-start', name: resolved.name, depth: (scope?.depth ?? 0) + 1 });
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
