/**
 * `coder task` and its detached `_worker`, plus the turn-execution machinery
 * they share. Dispatches to the configured agent chain (codex first by default,
 * claude as fallback) and manages a job's lifecycle to a terminal state.
 *
 * Exit codes (whole CLI):
 *   0    success
 *   1    the agent ran but the turn failed (do not fall back; report it)
 *   3    no engine in the chain could start — stdout carries a
 *        run-native-subagent payload: the host should run the task with its
 *        own native subagent facility (uniform across hosts)
 *   4    a --wait stopped because the task is waiting on an approval — answer it
 *        with `coder approve`, then re-wait (see EXIT_APPROVAL_NEEDED)
 *   130  interrupted (SIGINT) — the task keeps running detached
 *   143  terminated (SIGTERM)
 * (2 is left unused — it is the conventional CLI usage-error code.)
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

import { parseArgs } from '../lib/args.js';
import {
  appendJobLog,
  findJob,
  generateJobId,
  readJob,
  readJobLog,
  resolveJobDir,
  resolveWorkspaceRoot,
  touchActivity,
  writeJob,
  type JobLogEntry,
} from '../lib/state.js';
import { waitForTaskAttention } from '../lib/wait.js';
import { getCodexAvailability, runTurn } from '../lib/codex-core.js';
import { getClaudeAvailability, runClaudeTurn } from '../lib/claude-core.js';
import { createApprovalHandler, probeApproval } from '../lib/approvals.js';
import { ensureCodexInstalled } from '../lib/plugins.js';
import { startChatBridge } from '../lib/chat-bridge.js';
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  CLAUDE_SANDBOX_UNAVAILABLE_PATTERN,
  CODEX_EFFORTS,
  CODEX_MODELS,
  PERMISSION_MODES,
  loadConfig,
  resolveCodexModel,
  resolveCustomModel,
} from '../lib/config.js';
import { fail, formatTokens, outStyle, printJson, resolveCwd, surfaceApproval } from '../lib/ui.js';
import { CLI_PATH } from '../lib/runtime.js';
import type {
  Agent,
  CoderConfig,
  Engine,
  Job,
  ProgressUpdate,
  ResolvedTaskOptions,
  TurnResult,
} from '../lib/types.js';

const STARTUP_ERROR_PATTERN =
  /usage|quota|rate.?limit|429|401|unauthorized|not authenticated|login|insufficient|exhausted|not available|ENOENT/i;

// Marks a worker's whole process tree (engine, agent shell) so task-creating
// commands can refuse nested dispatch.
const WORKER_ENV = 'CODER_WORKER';

// Prepended to the initial turn only; resumed turns inherit it from the thread.
const WORKER_SYSTEM_PROMPT =
  'You are running inside a coder task: do the work yourself, directly. ' +
  'Do not load the coder skill (recursive), and never dispatch through the `coder` CLI - ' +
  'nested dispatch is disabled.\n\n---------\n\n';

function taskPrompt(job: Job): string {
  return job.resumeThreadId ? (job.prompt ?? '') : WORKER_SYSTEM_PROMPT + (job.prompt ?? '');
}

function resolveTaskOptions(
  options: Record<string, any>,
  config: CoderConfig,
): ResolvedTaskOptions {
  // A bare model implies its agent: opus/sonnet/fable -> claude,
  // spark/luna/terra/sol -> codex, a configured custom-model name -> custom
  // (the maps are disjoint - `coder model add` reserves the built-in names -
  // so it is unambiguous).
  // Explicit --agent always wins; unknown/raw slugs keep the chain default.
  let agent = options.agent;
  if (!agent && options.model) {
    if (options.model in CLAUDE_MODELS) {
      agent = 'claude';
    } else if (options.model in CODEX_MODELS) {
      agent = 'codex';
    } else if (options.model in (config.models ?? {})) {
      agent = 'custom';
    }
  }
  agent = agent ?? config.chain[0] ?? 'codex';
  if (agent !== 'codex' && agent !== 'claude' && agent !== 'custom') {
    const hint =
      agent in CODEX_MODELS || agent in CLAUDE_MODELS || agent in (config.models ?? {})
        ? ` "${agent}" is a model; use --model ${agent}.`
        : '';
    fail(`Invalid --agent "${agent}". Use codex, claude, or custom.${hint}`);
  }
  const agentDefaults = config.agents[agent as Agent] ?? {};
  let model = options.model ?? agentDefaults.model ?? null;
  const effort = options.effort ?? agentDefaults.effort ?? null;
  const permissions = options.permissions ?? agentDefaults.permissions ?? 'auto';

  // The custom agent groups the user's configured (OpenAI-compatible) models;
  // the codex engine runs them underneath. Unlike codex/claude there is no
  // raw-slug passthrough: the model must be a config entry, so typos fail
  // here with the configured names instead of reaching an engine.
  if (agent === 'custom') {
    const names = Object.keys(config.models ?? {});
    if (!model && names.length === 1) {
      model = names[0]!;
    }
    if (!model || !(model in (config.models ?? {}))) {
      fail(
        model
          ? `No custom model named "${model}". Configured: ${names.join(', ') || 'none'}.`
          : 'No custom model to run: pass --model <name> or set agents.custom.model.',
        { hint: 'Add one: coder model add <name> --base-url <url> --model <id>' },
      );
    }
  }
  const engine: Engine = agent === 'claude' ? 'claude' : 'codex';

  if (!(permissions in PERMISSION_MODES)) {
    fail(
      `Invalid --permissions "${permissions}". Use one of: ${Object.keys(PERMISSION_MODES).join(', ')}`,
    );
  }
  if (engine === 'codex' && effort && !CODEX_EFFORTS.has(effort)) {
    fail(`Invalid codex --effort "${effort}". Use one of: ${[...CODEX_EFFORTS].join(', ')}`);
  }
  if (engine === 'claude' && effort && !CLAUDE_EFFORTS.has(effort)) {
    fail(`Invalid claude --effort "${effort}". Use one of: ${[...CLAUDE_EFFORTS].join(', ')}`);
  }

  return { engine, agent, model, effort, permissions };
}

// Throttled sign-of-life marker: engines fire this on every server event
// (including unlogged output deltas); a 10s floor keeps the file writes cheap.
function buildHeartbeat(cwd: string, jobId: string) {
  let last = 0;
  return () => {
    if (Date.now() - last >= 10_000) {
      last = Date.now();
      touchActivity(cwd, jobId);
    }
  };
}

function buildProgressLogger(cwd: string, jobId: string, { echo }: { echo: boolean }) {
  return (update: ProgressUpdate) => {
    const entry = typeof update === 'string' ? { message: update } : update;
    appendJobLog(cwd, jobId, entry);
    if (echo && entry.message) {
      process.stderr.write(`[coder] ${entry.message}\n`);
    }
  };
}

async function executeCodexTurn(
  cwd: string,
  job: Job,
  { echo }: { echo: boolean },
): Promise<TurnResult> {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobDir = resolveJobDir(cwd, job.id);
  const config = loadConfig(cwd);
  const onProgress = buildProgressLogger(cwd, job.id, { echo });

  const mode = PERMISSION_MODES[job.permissions ?? 'auto'] ?? PERMISSION_MODES.auto;
  const onApprovalRequest =
    mode.approvalPolicy === 'never'
      ? undefined
      : createApprovalHandler({
          workspaceRoot,
          jobDir,
          mode: mode.approvalMode,
          escalationTimeoutMs: config.approvals.escalationTimeoutMs,
          allowedNetworkHosts: config.approvals.allowedNetworkHosts,
          onEvent: event => {
            appendJobLog(cwd, job.id, event as JobLogEntry);
            if (echo && event.message) {
              process.stderr.write(`[coder] ${event.message}\n`);
            }
          },
        });

  // A custom-model alias runs on codex pointed at the user's endpoint; the
  // provider entry travels as per-thread config overrides. Chat-completions
  // endpoints (the default) get a per-turn responses->chat bridge in front.
  const customEntry = job.model ? config.models?.[job.model] : undefined;
  const bridge =
    customEntry && (customEntry.wireApi ?? 'chat') === 'chat'
      ? await startChatBridge(customEntry)
      : null;
  const custom = resolveCustomModel(config, job.model, bridge ?? undefined);
  try {
    const result = await runTurn(cwd, {
      prompt: taskPrompt(job),
      model: custom?.model ?? resolveCodexModel(job.model),
      modelProvider: custom?.modelProvider ?? null,
      configOverrides: custom?.configOverrides ?? null,
      effort: job.effort,
      sandbox: mode.sandbox,
      approvalPolicy: mode.approvalPolicy,
      onApprovalRequest,
      onHeartbeat: buildHeartbeat(cwd, job.id),
      resumeThreadId: job.resumeThreadId ?? null,
      onProgress: (update: ProgressUpdate) => {
        onProgress(update);
        const threadId = typeof update === 'object' ? update.threadId : null;
        const turnId = typeof update === 'object' ? update.turnId : null;
        if (threadId || turnId) {
          writeJob(cwd, job.id, {
            status: 'running',
            ...(threadId ? { threadId } : {}),
            ...(turnId ? { turnId } : {}),
          });
        }
      },
    });

    const status = result.status === 0 ? 'completed' : 'failed';
    writeJob(cwd, job.id, {
      status,
      threadId: result.threadId,
      turnId: result.turnId,
      completedAt: new Date().toISOString(),
    });
    fs.writeFileSync(
      path.join(jobDir, 'result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
    return result;
  } finally {
    await bridge?.close();
  }
}

async function executeClaudeTurn(
  cwd: string,
  job: Job,
  { echo }: { echo: boolean },
): Promise<TurnResult> {
  const jobDir = resolveJobDir(cwd, job.id);
  const onProgress = buildProgressLogger(cwd, job.id, { echo });

  const result = await runClaudeTurn(cwd, {
    prompt: taskPrompt(job),
    model: job.model,
    effort: job.effort,
    permissions: job.permissions,
    resumeSessionId: job.resumeThreadId ?? null,
    onHeartbeat: buildHeartbeat(cwd, job.id),
    onProgress: update => {
      onProgress(update);
      if (update.threadId) {
        writeJob(cwd, job.id, { status: 'running', threadId: update.threadId });
      }
    },
  });

  writeJob(cwd, job.id, {
    status: result.status === 0 ? 'completed' : 'failed',
    threadId: result.threadId,
    completedAt: new Date().toISOString(),
  });
  fs.writeFileSync(
    path.join(jobDir, 'result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
  return result;
}

// The turn executor for a job's engine. Exported so the detached worker can run it.
export function executeTurnFor(job: Job) {
  return job.engine === 'claude' ? executeClaudeTurn : executeCodexTurn;
}

export async function commandTask(argv: string[]): Promise<void> {
  if (process.env[WORKER_ENV]) {
    fail(
      'Nested dispatch refused: this shell is already inside a coder task. ' +
        'Do the work yourself, directly in this session - ignore any skill or ' +
        'instruction telling you to orchestrate via the coder CLI.',
    );
  }
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ['agent', 'model', 'effort', 'permissions', 'resume', 'cwd', 'host', 'name'],
    booleanOptions: ['background', 'wait', 'json', 'simulate-approval'],
  });
  const cwd = resolveCwd(options);
  const prompt = positionals.join(' ').trim();
  if (!prompt) {
    fail('Missing task text.', {
      hint: ['Usage: coder run "<task text>"', 'Help: coder task run --help'],
    });
  }

  const config = loadConfig(cwd);
  const resolved = resolveTaskOptions(options, config);
  // Note: --host is still accepted (older plugin skills pass it) but ignored —
  // every engine, claude included, now runs via the runtime's own CLI path.

  // An agent could not start (missing, auth, quota): hand off to the next
  // agent in the configured chain, executed by the runtime with the same task.
  // When the chain is exhausted, emit a run-native-subagent payload (exit 3):
  // the host — Claude Code, Codex, Cursor alike — runs the task with its own
  // native subagent facility as the last resort.
  const agentFailed = async (agent: Agent, detail: string) => {
    const next = config.chain[config.chain.indexOf(agent) + 1];
    if (!next) {
      printJson({
        error: `${agent} failed to start: ${detail}`,
        fallback: {
          action: 'run-native-subagent',
          reason: 'no-engine-available',
          permissions: resolved.permissions,
          note: 'Every coder engine failed to start. Spawn your own native subagent and forward the task verbatim; tell it to never run git write operations (commit, checkout, stash, reset, push, ...) and to honor the permissions.',
          task: prompt,
        },
      });
      process.exit(3);
    }
    process.stderr.write(
      `[coder] ${agent} failed to start (${detail}); falling back to ${next}.\n`,
    );
    await commandTask([
      prompt,
      '--agent',
      next,
      '--cwd',
      cwd,
      ...(options.wait ? ['--wait'] : []),
      ...(options.json ? ['--json'] : []),
      ...(options.permissions ? ['--permissions', options.permissions] : []),
    ]);
    process.exit(0);
  };

  // read-only leans on the OS sandbox; if it cannot start, the mode itself is
  // unavailable here. This is NOT a chain fallback (the next engine would just
  // write to the repo, defeating read-only): report the constraint to the
  // orchestrator so it can re-dispatch with a writable mode or fix the host.
  const readOnlyUnavailable = (detail: string) => {
    const hint =
      'read-only unavailable on this host: the OS sandbox failed to start ' +
      '(Linux/WSL2 needs bubblewrap + socat). Re-dispatch with --permissions auto ' +
      '(or workspace-write) if writes are acceptable, or install the sandbox deps.';
    if (options.json) {
      printJson({ error: hint, code: 'read-only-unavailable', detail });
    } else {
      process.stderr.write(`[coder] ${hint}\n`);
    }
    process.exit(1);
  };
  const isSandboxFailure = (detail: string) =>
    resolved.permissions === 'read-only' && CLAUDE_SANDBOX_UNAVAILABLE_PATTERN.test(detail ?? '');

  // Startup gate: cheap checks before creating a job, so failures classify
  // cleanly as "fall back to the next agent".
  {
    let availability =
      resolved.engine === 'codex' ? getCodexAvailability(cwd) : getClaudeAvailability();
    // A task on a custom model needs the codex engine but no codex login, so a
    // missing binary is installed on the spot instead of falling back.
    if (!availability.available && resolved.model && resolved.model in (config.models ?? {})) {
      const install = ensureCodexInstalled(availability);
      process.stderr.write(`[coder] ${install!.note}\n`);
      availability = getCodexAvailability(cwd);
    }
    if (!availability.available) {
      await agentFailed(resolved.agent, availability.detail);
    }
  }

  let resumeThreadId = null;
  if (options.resume) {
    const referenced = findJob(cwd, options.resume);
    resumeThreadId = referenced?.threadId ?? options.resume;
  }

  const jobId = generateJobId();
  const job = writeJob(cwd, jobId, {
    status: 'queued',
    kind: 'task',
    name: options.name ?? null,
    agent: resolved.agent,
    engine: resolved.engine,
    prompt,
    model: resolved.model,
    effort: resolved.effort,
    permissions: resolved.permissions,
    resumeThreadId,
    cwd,
    background: !options.wait,
    ...(options['simulate-approval'] ? { simulateApproval: true } : {}),
  });

  // Always run the task in a detached worker, so interrupting the CLI never
  // kills the task. --wait just blocks on the result afterward (Ctrl-C detaches).
  const jobDir = resolveJobDir(cwd, jobId);
  const logFd = fs.openSync(path.join(jobDir, 'worker.log'), 'a');
  const child = spawn(process.execPath, [CLI_PATH, '_worker', jobId, '--cwd', cwd], {
    cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, [WORKER_ENV]: '1' },
  });
  child.unref();
  fs.closeSync(logFd);
  writeJob(cwd, jobId, { pid: child.pid ?? null });

  // Startup check: wait until the worker reports a live thread, then until its
  // NEXT event lands (the first real output, or a failure) — not a fixed timer.
  // Auth/quota/missing-binary surface either as a failed status or as that
  // first event, so once the thread appears we only wait for the worker to say
  // something more, capped by a short settle window as a safety net.
  const ALL = Number.MAX_SAFE_INTEGER;
  const deadline = Date.now() + 15_000;
  let current = job;
  let threadLogLen: number | null = null;
  let settleDeadline: number | null = null;
  while (Date.now() < (settleDeadline ?? deadline)) {
    current = readJob(cwd, jobId) ?? current;
    if (current.status === 'failed' || current.status === 'completed') {
      break;
    }
    if (current.threadId && threadLogLen === null) {
      // Baseline the log at the moment the thread appears; a live thread with a
      // short settle window bounds the wait if the worker then goes quiet.
      threadLogLen = readJobLog(cwd, jobId, ALL).length;
      settleDeadline = Date.now() + 2_000;
    }
    // Pass as soon as the worker emits its next event after the thread is live.
    if (threadLogLen !== null && readJobLog(cwd, jobId, ALL).length > threadLogLen) {
      current = readJob(cwd, jobId) ?? current;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  if (current.status === 'failed') {
    // Turn errors (sandbox init, usage/auth) land in result.json, not the
    // progress log, so prefer it and fall back to the log tail.
    const resultFile = path.join(jobDir, 'result.json');
    const resultError = fs.existsSync(resultFile)
      ? (JSON.parse(fs.readFileSync(resultFile, 'utf8')).error?.message ?? '')
      : '';
    const logTail = readJobLog(cwd, jobId, 5)
      .map(entry => entry.message ?? '')
      .join('\n');
    const detail = resultError || logTail;
    if (isSandboxFailure(detail)) {
      readOnlyUnavailable(detail);
    }
    if (STARTUP_ERROR_PATTERN.test(detail)) {
      await agentFailed(resolved.agent, detail);
    }
    if (options.json) {
      printJson({ taskId: jobId, status: 'failed', detail });
      process.exit(1);
    }
    fail(`Task ${jobId} failed to start.${detail ? `\n${detail}` : ''}`, {
      hint: `See: coder task result ${jobId}`,
    });
  }

  // Commands to manage the task, shared by the --wait notice and the plain
  // background output.
  const manageBlock = [
    `  result:  coder task result ${jobId}`,
    `  steer:   coder task steer ${jobId} "<follow-up>"`,
  ].join('\n');

  if (options.wait) {
    // Block on the result. The task runs in the detached worker, so Ctrl-C here
    // only detaches — it keeps running and can be picked up with `coder result`.
    // Print the task id + management commands (to stderr; stdout stays the answer).
    if (!options.json) {
      process.stderr.write(
        `${outStyle.dim('[coder]')} task ${outStyle.cyan(jobId)} started (${current.status}); waiting for it to finish — Ctrl-C to detach (it keeps running).\n`,
      );
      process.stderr.write(`${outStyle.dim(manageBlock)}\n`);
    }
    const onSigint = () => {
      process.stderr.write(
        `\n${outStyle.dim(`[coder] detached — task still running: coder task result ${jobId}`)}\n`,
      );
      process.exit(130);
    };
    process.on('SIGINT', onSigint);
    const outcome = await waitForTaskAttention(cwd, current);
    process.off('SIGINT', onSigint);
    if (outcome.reason === 'approval') {
      surfaceApproval(jobId, outcome.approval!, options.json);
    }
    const final = outcome.job;

    const resultFile = path.join(jobDir, 'result.json');
    const result = fs.existsSync(resultFile)
      ? JSON.parse(fs.readFileSync(resultFile, 'utf8'))
      : null;
    // A usage/quota/auth error that ended the turn -> fall back to the next engine.
    const turnError = result?.error?.message ?? '';
    if (final.status === 'failed' && isSandboxFailure(turnError)) {
      readOnlyUnavailable(turnError);
    }
    if (final.status === 'failed' && STARTUP_ERROR_PATTERN.test(turnError)) {
      await agentFailed(resolved.agent, turnError);
    }
    if (options.json) {
      printJson({
        taskId: jobId,
        status: final.status,
        finalMessage: result?.finalMessage,
        ...(turnError ? { error: turnError } : {}),
        tokens: result?.tokens ?? null,
        model: result?.model ?? final.model ?? null,
      });
    } else {
      // Blank lines around the answer so it stands apart from the [coder] chrome.
      process.stdout.write(
        `\n${result?.finalMessage || (turnError ? `${outStyle.red('error:')} ${turnError}` : '(no final message)')}\n\n`,
      );
      const tokensNote = result?.tokens
        ? ` tokens=${formatTokens(result.tokens, result.model ?? final.model)}`
        : '';
      process.stderr.write(
        `${outStyle.dim(`[coder] task=${jobId} status=${final.status}${tokensNote}`)}\n`,
      );
    }
    process.exit(final.status === 'completed' ? 0 : 1);
  }

  // No --wait: print the task id and the commands to manage it.
  if (options.json) {
    printJson({
      taskId: jobId,
      status: current.status,
      startupCheck: current.threadId ? 'passed' : 'pending',
      commands: {
        result: `coder task result ${jobId}`,
        steer: `coder task steer ${jobId} "<follow-up>"`,
        stop: `coder task stop ${jobId}`,
        watch: `coder task stream ${jobId}`,
      },
    });
    return;
  }
  process.stdout.write(
    `${outStyle.dim('[coder]')} task ${outStyle.cyan(jobId)} started in the background (${current.status}).\n`,
  );
  process.stdout.write(`${outStyle.dim(manageBlock)}\n`);
}

export async function commandWorker(argv: string[]): Promise<void> {
  const { options, positionals } = parseArgs(argv, { valueOptions: ['cwd'] });
  const cwd = resolveCwd(options);
  const jobId = positionals[0];
  const job = readJob(cwd, jobId);
  if (!job) {
    fail(`Worker: task ${jobId} not found.`);
  }

  writeJob(cwd, jobId, { status: 'running', pid: process.pid });
  try {
    // Dev hook: raise one real pending approval and block on it before the turn,
    // so the escalate -> --wait exit 4 -> `coder approve` loop can be exercised.
    if (job.simulateApproval) {
      const decision = await probeApproval(resolveJobDir(cwd, jobId), {
        onEvent: event => appendJobLog(cwd, jobId, event as JobLogEntry),
      });
      appendJobLog(cwd, jobId, { message: `simulated approval: ${decision}` });
      if (decision === 'decline') {
        writeJob(cwd, jobId, {
          status: 'cancelled',
          completedAt: new Date().toISOString(),
          error: 'simulated approval denied',
        });
        return;
      }
    }
    await executeTurnFor(job)(cwd, job, { echo: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJob(cwd, jobId, { status: 'failed', error: message });
    appendJobLog(cwd, jobId, { kind: 'error', message });
    process.exit(1);
  }
}
