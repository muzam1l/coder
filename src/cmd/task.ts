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

import * as z from 'zod/mini';

import { baseOptions, flag, parseArgs, str } from '../lib/args.js';
import {
  appendJobLog,
  claimSteers,
  readJob,
  resolveJobDir,
  resolveWorkspaceRoot,
  touchActivity,
  writeJob,
  type JobLogEntry,
} from '../lib/state.js';
import { writeJsonFileAtomic } from '../lib/fsx.js';
import { runTurn } from '../lib/codex-core.js';
import { runClaudeTurn } from '../lib/claude-core.js';
import { createApprovalHandler, probeApproval } from '../lib/approvals.js';
import { startChatBridge } from '../lib/chat-bridge.js';
import {
  PERMISSION_MODES,
  isEndpointModel,
  loadConfig,
  persistModelPatch,
  resolveCodexModel,
  resolveCustomModel,
} from '../lib/config.js';
import { detectWireApi } from '../lib/wire.js';
import { fail, formatTokens, outStyle, printJson, resolveCwd, surfaceApproval } from '../lib/ui.js';
import {
  CoderError,
  STARTUP_ERROR_PATTERN,
  WORKER_ENV,
  buildFallbackPayload,
  dispatchTask,
  isSandboxFailure,
  waitTask,
  type DispatchOptions,
  type DispatchResult,
} from '../lib/dispatch.js';
import type { Job, ProgressUpdate, TurnResult } from '../lib/types.js';

// Prepended to the initial turn only; resumed turns inherit it from the thread.
const WORKER_SYSTEM_PROMPT = `
You are running inside a coder task: do the work yourself, directly.
Do not load the coder skill (recursive), and never dispatch through the \`coder\` CLI - nested dispatch is disabled.
When finished, provide a concise implementation result summary.
Your turn is one-shot: background processes will not re-invoke you after it ends, so verify synchronously before finishing.
`.trim();

function taskPrompt(job: Job): string {
  if (job.resumeThreadId) return job.prompt ?? '';
  // --system instructions sit below the worker preamble inside the <system> element.
  const system = job.system ? `\n-------\n${job.system}` : '';
  return `<system>
${WORKER_SYSTEM_PROMPT}${system}
</system>

${job.prompt ?? ''}`;
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
  // endpoints get a per-turn responses->chat bridge in front.
  const configuredEntry = job.model ? config.models?.[job.model] : undefined;
  let customEntry = configuredEntry && isEndpointModel(configuredEntry) ? configuredEntry : undefined;
  // `coder model add` writes wireApi (and the resolved base URL) explicitly; a
  // missing field means a hand-written entry, so run the same detection here
  // and save it back so later turns skip the probe. On no answer (endpoint
  // down), fall back to chat for this turn without persisting.
  if (customEntry && !customEntry.wireApi && job.model) {
    const detected = await detectWireApi(customEntry);
    if (detected) {
      customEntry = { ...customEntry, ...detected };
      config.models![job.model] = customEntry;
      persistModelPatch(cwd, job.model, detected);
      appendJobLog(cwd, job.id, {
        kind: 'info',
        message: `detected wire api for ${job.model}: ${detected.wireApi} @ ${customEntry.baseUrl}`,
      } as JobLogEntry);
    }
  }
  // Every custom model goes through the loopback bridge: it runs here in the
  // worker (whose env is the caller's) and injects the API key itself —
  // codex's own env_key would resolve inside the shared broker, whose env is
  // frozen from whenever it was first spawned.
  if (customEntry?.envKey && !process.env[customEntry.envKey]) {
    throw new Error(`Missing environment variable: \`${customEntry.envKey}\`.`);
  }
  const bridge = customEntry
    ? await startChatBridge(customEntry, customEntry.wireApi ?? 'chat')
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
    writeJsonFileAtomic(path.join(jobDir, 'result.json'), result);
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
  writeJsonFileAtomic(path.join(jobDir, 'result.json'), result);
  return result;
}

// The turn executor for a job's engine. Exported so the detached worker can run it.
export function executeTurnFor(job: Job) {
  return job.engine === 'claude' ? executeClaudeTurn : executeCodexTurn;
}

// After a turn completes, run any follow-ups that were queued by `coder task
// steer` while the task was running but could not be injected into the live
// turn (a codex non-steerable window, or the claude engine). Each runs as a
// resumed turn on the same thread, in order. A short grace re-check closes the
// race with a steer that lands as the turn is completing; a failed/cancelled
// task is left terminal rather than resumed.
async function drainSteerQueue(cwd: string, jobId: string): Promise<void> {
  for (let idleChecks = 0; idleChecks < 2; ) {
    const current = readJob(cwd, jobId);
    if (!current || current.status === 'failed' || current.status === 'cancelled') {
      return;
    }
    const followUps = claimSteers(cwd, jobId);
    if (followUps.length === 0) {
      idleChecks += 1;
      await new Promise(resolve => setTimeout(resolve, 300));
      continue;
    }
    idleChecks = 0;
    for (const text of followUps) {
      const resumeJob = writeJob(cwd, jobId, {
        status: 'running',
        prompt: text,
        resumeThreadId: current.threadId ?? null,
      });
      appendJobLog(cwd, jobId, { message: 'Running steered follow-up.' });
      try {
        await executeTurnFor(resumeJob)(cwd, resumeJob, { echo: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeJob(cwd, jobId, { status: 'failed', error: message });
        appendJobLog(cwd, jobId, { kind: 'error', message });
        return;
      }
    }
  }
}

// Map a typed dispatch error to the CLI's exit code + stdout/stderr output.
// Never returns.
function handleDispatchError(error: unknown, options: Record<string, any>): never {
  if (error instanceof CoderError) {
    switch (error.code) {
      case 'chain-exhausted':
        printJson(error.payload);
        process.exit(3);
      case 'read-only-unavailable':
        readOnlyUnavailable(error.message, options);
        break;
      case 'startup-failed':
        if (options.json) {
          printJson({ taskId: error.taskId, status: 'failed', detail: error.message });
          process.exit(1);
        }
        fail(`Task ${error.taskId} failed to start.${error.message ? `\n${error.message}` : ''}`, {
          hint: `See: coder task result ${error.taskId}`,
        });
        break;
      default:
        fail(error.message, error.hint ? { hint: error.hint } : {});
    }
  }
  throw error;
}

// read-only leans on the OS sandbox; if it cannot start, the mode itself is
// unavailable here. Reported (exit 1) rather than chained.
function readOnlyUnavailable(detail: string, options: Record<string, any>): never {
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
}

export async function commandTask(argv: string[]): Promise<void> {
  if (process.env[WORKER_ENV]) {
    fail(
      'Nested dispatch refused: this shell is already inside a coder task. ' +
        'Do the work yourself, directly in this session - ignore any skill or ' +
        'instruction telling you to orchestrate via the coder CLI.',
    );
  }
  const { options, positionals } = parseArgs(
    argv,
    z.object({
      ...baseOptions,
      agent: str,
      model: str,
      effort: str,
      permissions: str,
      resume: str,
      host: str,
      name: str,
      system: str,
      background: flag,
      wait: flag,
      'simulate-approval': flag,
    }),
  );
  const cwd = resolveCwd(options);
  const prompt = positionals.join(' ').trim();
  if (!prompt) {
    fail('Missing task text.', {
      hint: ['Usage: coder run "<task text>"', 'Help: coder task run --help'],
    });
  }
  // Note: --host is still accepted (older plugin skills pass it) but ignored —
  // every engine, claude included, now runs via the runtime's own CLI path.

  const dispatchOpts: DispatchOptions = {
    prompt,
    cwd,
    agent: options.agent,
    model: options.model,
    effort: options.effort,
    permissions: options.permissions,
    name: options.name,
    system: options.system,
    resume: options.resume,
    wait: options.wait,
    simulateApproval: options['simulate-approval'],
    onFallback: ({ agent, detail, next }) =>
      process.stderr.write(
        `[coder] ${agent} failed to start (${detail}); falling back to ${next}.\n`,
      ),
    onInstallNote: note => process.stderr.write(`[coder] ${note}\n`),
  };

  let dispatch: DispatchResult;
  try {
    dispatch = await dispatchTask(dispatchOpts);
  } catch (error) {
    handleDispatchError(error, options);
  }

  if (options.wait) {
    // Block on the result, walking the chain if a turn ends with a startup-ish
    // error (usage/auth/quota) — same behavior as a startup fallback.
    for (;;) {
      const jobId = dispatch.taskId;
      const current = dispatch.job;
      const manageBlock = [
        `  result:  coder task result ${jobId}`,
        `  steer:   coder task steer ${jobId} "<follow-up>"`,
      ].join('\n');
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
      let waited;
      try {
        waited = await waitTask(cwd, jobId);
      } catch (error) {
        process.off('SIGINT', onSigint);
        if (error instanceof CoderError && error.code === 'approval-pending') {
          surfaceApproval(jobId, error.approval!, options.json);
        }
        throw error;
      }
      process.off('SIGINT', onSigint);

      const final = waited.job;
      const result = waited.result;
      const turnError = result?.error?.message ?? '';
      if (final.status === 'failed' && isSandboxFailure(final.permissions ?? 'auto', turnError)) {
        readOnlyUnavailable(turnError, options);
      }
      if (final.status === 'failed' && STARTUP_ERROR_PATTERN.test(turnError)) {
        const chain = loadConfig(cwd).chain;
        const next = chain[chain.indexOf(dispatch.agent) + 1];
        if (!next) {
          printJson(
            buildFallbackPayload(
              dispatch.agent,
              turnError,
              final.permissions ?? 'auto',
              options.system,
              prompt,
            ),
          );
          process.exit(3);
        }
        process.stderr.write(
          `[coder] ${dispatch.agent} failed to start (${turnError}); falling back to ${next}.\n`,
        );
        try {
          dispatch = await dispatchTask({
            ...dispatchOpts,
            agent: next,
            model: undefined,
            effort: undefined,
            name: undefined,
            resume: undefined,
            simulateApproval: undefined,
          });
        } catch (error) {
          handleDispatchError(error, options);
        }
        continue;
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
  }

  // No --wait: print the task id and the commands to manage it.
  const jobId = dispatch.taskId;
  const current = dispatch.job;
  const manageBlock = [
    `  result:  coder task result ${jobId}`,
    `  steer:   coder task steer ${jobId} "<follow-up>"`,
  ].join('\n');
  if (options.json) {
    printJson({
      taskId: jobId,
      status: current.status,
      startupCheck: dispatch.startupCheck,
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
  const { options, positionals } = parseArgs(argv, z.object({ cwd: str }));
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
    // Run any follow-ups steered in while this turn was mid-flight.
    await drainSteerQueue(cwd, jobId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJob(cwd, jobId, { status: 'failed', error: message });
    appendJobLog(cwd, jobId, { kind: 'error', message });
    process.exit(1);
  }
}
