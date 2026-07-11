/**
 * `coder task` and its detached `_worker`, plus the turn-execution machinery
 * they share. Dispatches to the configured agent chain (codex first by default,
 * claude as fallback) and manages a job's lifecycle to a terminal state.
 *
 * Exit codes (whole CLI):
 *   0    success
 *   1    the agent ran but the turn failed (do not fall back; report it)
 *   3    the agent failed to start (auth/quota/missing binary) — fall back to
 *        the next agent in the chain
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
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  CLAUDE_SANDBOX_UNAVAILABLE_PATTERN,
  CODEX_EFFORTS,
  CODEX_MODELS,
  PERMISSION_MODES,
  loadConfig,
  resolveCodexModel,
} from '../lib/config.js';
import { fail, formatTokens, outStyle, printJson, resolveCwd, surfaceApproval } from '../lib/ui.js';
import { CLI_PATH } from '../lib/runtime.js';
import type {
  Agent,
  CoderConfig,
  Job,
  Permission,
  ProgressUpdate,
  ResolvedTaskOptions,
  TurnResult,
} from '../lib/types.js';

const STARTUP_ERROR_PATTERN =
  /usage|quota|rate.?limit|429|401|unauthorized|not authenticated|login|insufficient|exhausted|not available|ENOENT/i;

function resolveTaskOptions(
  options: Record<string, any>,
  config: CoderConfig,
): ResolvedTaskOptions {
  // A bare model alias implies its engine: opus/sonnet/fable -> claude,
  // spark/luna/terra/sol -> codex (the alias maps are disjoint, so it is
  // unambiguous).
  // Explicit --agent always wins; unknown/raw slugs keep the chain default.
  let agent = options.agent;
  if (!agent && options.model) {
    if (options.model in CLAUDE_MODELS) {
      agent = 'claude';
    } else if (options.model in CODEX_MODELS) {
      agent = 'codex';
    }
  }
  agent = agent ?? config.chain[0] ?? 'codex';
  if (agent !== 'codex' && agent !== 'claude') {
    const hint =
      agent in CODEX_MODELS || agent in CLAUDE_MODELS
        ? ` "${agent}" is a model; use --model ${agent}.`
        : '';
    fail(`Invalid --agent "${agent}". Use codex or claude.${hint}`);
  }
  const agentDefaults = config.agents[agent as Agent] ?? {};
  const model = options.model ?? agentDefaults.model ?? null;
  const effort = options.effort ?? agentDefaults.effort ?? null;
  const permissions = options.permissions ?? agentDefaults.permissions ?? 'auto';

  if (!(permissions in PERMISSION_MODES)) {
    fail(
      `Invalid --permissions "${permissions}". Use one of: ${Object.keys(PERMISSION_MODES).join(', ')}`,
    );
  }
  if (agent === 'codex' && effort && !CODEX_EFFORTS.has(effort)) {
    fail(`Invalid codex --effort "${effort}". Use one of: ${[...CODEX_EFFORTS].join(', ')}`);
  }
  if (agent === 'claude' && effort && !CLAUDE_EFFORTS.has(effort)) {
    fail(`Invalid claude --effort "${effort}". Use one of: ${[...CLAUDE_EFFORTS].join(', ')}`);
  }

  return { agent, model, effort, permissions };
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

function claudeDispatchPayload(
  config: CoderConfig,
  task: string,
  reason: string,
  permissions: Permission | null = null,
) {
  const claude = config.agents.claude ?? {};
  return {
    agent: 'claude',
    action: 'spawn-claude-subagent',
    // "configured": claude is the selected agent (chain order or --agent).
    // "codex-failed": codex was selected but could not start.
    reason,
    model: claude.model ?? 'opus',
    permissions: permissions ?? claude.permissions ?? 'auto',
    note: 'Spawn a general-purpose subagent with this model and forward the task verbatim.',
    task,
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

  const result = await runTurn(cwd, {
    prompt: job.prompt ?? '',
    model: resolveCodexModel(job.model),
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
  fs.writeFileSync(path.join(jobDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

async function executeClaudeTurn(
  cwd: string,
  job: Job,
  { echo }: { echo: boolean },
): Promise<TurnResult> {
  const jobDir = resolveJobDir(cwd, job.id);
  const onProgress = buildProgressLogger(cwd, job.id, { echo });

  const result = await runClaudeTurn(cwd, {
    prompt: job.prompt ?? '',
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
  fs.writeFileSync(path.join(jobDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

// The turn executor for a job's agent. Exported so the detached worker can run it.
export function executeTurnFor(job: Job) {
  return job.agent === 'claude' ? executeClaudeTurn : executeCodexTurn;
}

export async function commandTask(argv: string[]): Promise<void> {
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
  // Host contract: only a "claude" host (Claude Code) can spawn Claude subagents
  // itself, so the runtime hands it a spawn-claude-subagent payload; every other
  // host (codex plugin, cursor plugin, plain shell) has no subagent facility, so
  // the runtime executes the claude engine via its own CLI. codex and cursor are
  // identical here - the value just lets a task self-identify its host.
  // Default host: inside a Claude Code shell (CLAUDECODE=1) the harness
  // interprets exit-3 payloads and spawns the subagent itself; anywhere else
  // (codex, cursor, plain terminal, CI) nobody is listening, so the runtime
  // executes the claude engine directly.
  const host = options.host ?? (process.env.CLAUDECODE ? 'claude' : 'codex');
  if (host !== 'claude' && host !== 'codex' && host !== 'cursor') {
    fail(`Invalid --host "${host}". Use claude, codex, or cursor.`);
  }

  if (resolved.agent === 'claude' && host === 'claude') {
    printJson(claudeDispatchPayload(config, prompt, 'configured', resolved.permissions));
    process.exit(0);
  }

  // An agent could not start (missing, auth, quota): hand off to the next
  // agent in the configured chain. A Claude host takes over via the exit-3
  // payload when the next engine is claude; otherwise the runtime executes
  // the next engine itself with the same task.
  const agentFailed = async (agent: Agent, detail: string) => {
    const next = config.chain[config.chain.indexOf(agent) + 1];
    if (!next) {
      fail(`${agent} failed to start: ${detail}`);
    }
    if (next === 'claude' && host === 'claude') {
      printJson({
        error: `${agent} failed to start: ${detail}`,
        fallback: claudeDispatchPayload(config, prompt, 'codex-failed', resolved.permissions),
      });
      process.exit(3);
    }
    process.stderr.write(`[coder] ${agent} failed to start (${detail}); falling back to ${next}.\n`);
    await commandTask([
      prompt,
      '--agent',
      next,
      '--host',
      host,
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
    const availability =
      resolved.agent === 'codex' ? getCodexAvailability(cwd) : getClaudeAvailability();
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
    host,
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
    `  stop:    coder task stop ${jobId}`,
    `  watch:   coder task stream ${jobId}`,
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
        tokens: result?.tokens ?? null,
        model: result?.model ?? final.model ?? null,
      });
    } else {
      process.stdout.write(`${result?.finalMessage || '(no final message)'}\n`);
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
