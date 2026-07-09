#!/usr/bin/env node
/**
 * Coder runtime CLI. Dispatches coding tasks to the configured agent chain
 * (codex first by default, claude as fallback) and manages job lifecycle:
 * status, result, steer, stop, approvals.
 *
 * Exit codes:
 *   0  success
 *   1  the agent ran but the turn failed (do not fall back; report it)
 *   3  the agent failed to start (auth/quota/missing binary) — fall back to
 *      the next agent in the chain
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.js';
import {
  appendJobLog,
  findJob,
  generateJobId,
  listJobs,
  readJob,
  readJobLog,
  resolveJobDir,
  resolveWorkspaceRoot,
  writeJob,
} from './lib/state.js';
import {
  getCodexAuthStatus,
  getCodexAvailability,
  interruptTurn,
  runTurn,
} from './lib/codex-core.js';
import { getClaudeAvailability, runClaudeTurn } from './lib/claude-core.js';
import { answerApproval, createApprovalHandler, listPendingApprovals } from './lib/approvals.js';
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  CLAUDE_SANDBOX_UNAVAILABLE_PATTERN,
  CODEX_EFFORTS,
  CODEX_MODELS,
  DEFAULT_CONFIG,
  PERMISSION_MODES,
  loadConfig,
  resolveCodexModel,
  resolveUserConfigFile,
  validateConfig,
  writeUserConfig,
} from './config.js';

const CLI_PATH = fileURLToPath(import.meta.url);
const STARTUP_ERROR_PATTERN =
  /usage|quota|rate.?limit|429|401|unauthorized|not authenticated|login|insufficient|exhausted|not available|ENOENT/i;

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requireJob(cwd, reference) {
  const job = findJob(cwd, reference);
  if (!job) {
    fail(reference ? `No job found for "${reference}".` : 'No jobs found for this workspace.');
  }
  return job;
}

function buildProgressLogger(cwd, jobId, { echo }) {
  return update => {
    const entry = typeof update === 'string' ? { message: update } : update;
    appendJobLog(cwd, jobId, entry);
    if (echo && entry.message) {
      process.stderr.write(`[coder] ${entry.message}\n`);
    }
  };
}

function resolveTaskOptions(options, config) {
  // A bare model alias implies its engine: opus/sonnet/fable -> claude,
  // spark/5.5 -> codex (the alias maps are disjoint, so it is unambiguous).
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
  const agentDefaults = config.agents[agent] ?? {};
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

function claudeDispatchPayload(config, task, reason, permissions = null) {
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

async function executeCodexTurn(cwd, job, { echo }) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobDir = resolveJobDir(cwd, job.id);
  const config = loadConfig(cwd);
  const onProgress = buildProgressLogger(cwd, job.id, { echo });

  const mode = PERMISSION_MODES[job.permissions] ?? PERMISSION_MODES.auto;
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
            appendJobLog(cwd, job.id, event);
            if (echo && event.message) {
              process.stderr.write(`[coder] ${event.message}\n`);
            }
          },
        });

  const result = await runTurn(cwd, {
    prompt: job.prompt,
    model: resolveCodexModel(job.model),
    effort: job.effort,
    sandbox: mode.sandbox,
    approvalPolicy: mode.approvalPolicy,
    onApprovalRequest,
    resumeThreadId: job.resumeThreadId ?? null,
    onProgress: update => {
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
}

async function executeClaudeTurn(cwd, job, { echo }) {
  const jobDir = resolveJobDir(cwd, job.id);
  const onProgress = buildProgressLogger(cwd, job.id, { echo });

  const result = await runClaudeTurn(cwd, {
    prompt: job.prompt,
    model: job.model,
    effort: job.effort,
    permissions: job.permissions,
    resumeSessionId: job.resumeThreadId ?? null,
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

function executeTurnFor(job) {
  return job.agent === 'claude' ? executeClaudeTurn : executeCodexTurn;
}

async function commandTask(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ['agent', 'model', 'effort', 'permissions', 'resume', 'cwd', 'host'],
    booleanOptions: ['background', 'wait', 'json'],
  });
  // Background is the default; --wait runs in the foreground and blocks.
  const background = options.wait ? false : true;
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const prompt = positionals.join(' ').trim();
  if (!prompt) {
    fail('Usage: coder task [options] "<task text>"');
  }

  const config = loadConfig(cwd);
  const resolved = resolveTaskOptions(options, config);
  // Host contract: "claude" hosts (Claude Code) spawn Claude subagents
  // themselves on exit 3; any other host (codex plugin, plain shell) has no
  // subagent facility, so the runtime executes claude via its own CLI.
  // Default host: inside a Claude Code shell (CLAUDECODE=1) the harness
  // interprets exit-3 payloads and spawns the subagent itself; anywhere else
  // (codex, plain terminal, CI) nobody is listening, so the runtime executes
  // the claude engine directly.
  const host = options.host ?? (process.env.CLAUDECODE ? 'claude' : 'codex');
  if (host !== 'claude' && host !== 'codex') {
    fail(`Invalid --host "${host}". Use claude or codex.`);
  }

  if (resolved.agent === 'claude' && host === 'claude') {
    printJson(claudeDispatchPayload(config, prompt, 'configured', resolved.permissions));
    process.exit(3);
  }

  // An agent could not start (missing, auth, quota): hand off to the next
  // agent in the configured chain. A Claude host takes over via the exit-3
  // payload when the next engine is claude; otherwise the runtime executes
  // the next engine itself with the same task.
  const agentFailed = async (agent, detail) => {
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
  const readOnlyUnavailable = detail => {
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
  const isSandboxFailure = detail =>
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
    agent: resolved.agent,
    host,
    prompt,
    model: resolved.model,
    effort: resolved.effort,
    permissions: resolved.permissions,
    resumeThreadId,
    cwd,
    background,
  });

  if (background) {
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

    // Startup check: wait until the worker reports a live thread or fails.
    // Usage-limit errors land moments AFTER the thread is ready, so once the
    // thread appears keep watching briefly before declaring startup passed.
    const deadline = Date.now() + 15_000;
    let current = job;
    let graceDeadline = null;
    while (Date.now() < (graceDeadline ?? deadline)) {
      current = readJob(cwd, jobId) ?? current;
      if (current.status === 'failed' || current.status === 'completed') {
        break;
      }
      if (current.threadId && !graceDeadline) {
        graceDeadline = Date.now() + 5_000;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    if (current.status === 'failed') {
      // Turn errors (sandbox init, usage/auth) land in result.json, not the
      // progress log, so prefer it and fall back to the log tail.
      const resultFile = path.join(resolveJobDir(cwd, jobId), 'result.json');
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
      printJson({ jobId, status: 'failed', detail });
      process.exit(1);
    }

    printJson({
      jobId,
      status: current.status,
      threadId: current.threadId ?? null,
      startupCheck: current.threadId ? 'passed' : 'pending',
      commands: {
        status: `coder status ${jobId}`,
        result: `coder result ${jobId}`,
        steer: `coder steer ${jobId} "<follow-up>"`,
        stop: `coder stop ${jobId}`,
      },
    });
    return;
  }

  writeJob(cwd, jobId, { status: 'running', pid: process.pid });
  try {
    const current = readJob(cwd, jobId);
    const result = await executeTurnFor(current)(cwd, current, { echo: !options.json });
    // Usage/auth/quota errors arrive as turn-level error notifications, not
    // thrown startup errors — classify them as "fall back" too. A read-only
    // sandbox failure is checked first: it is a policy constraint, not a
    // fall-back trigger.
    const turnError = result.error?.message ?? '';
    if (result.status !== 0 && isSandboxFailure(turnError)) {
      readOnlyUnavailable(turnError);
    }
    if (result.status !== 0 && STARTUP_ERROR_PATTERN.test(turnError)) {
      await agentFailed(resolved.agent, turnError);
    }
    if (options.json) {
      printJson({
        jobId,
        status: result.status === 0 ? 'completed' : 'failed',
        threadId: result.threadId,
        finalMessage: result.finalMessage,
      });
    } else {
      process.stdout.write(`${result.finalMessage || '(no final message)'}\n`);
      process.stderr.write(
        `[coder] job=${jobId} thread=${result.threadId} status=${result.status === 0 ? 'completed' : 'failed'}\n`,
      );
    }
    process.exit(result.status === 0 ? 0 : 1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJob(cwd, jobId, { status: 'failed', error: message });
    appendJobLog(cwd, jobId, { kind: 'error', message });
    if (isSandboxFailure(message)) {
      readOnlyUnavailable(message);
    }
    if (STARTUP_ERROR_PATTERN.test(message)) {
      await agentFailed(resolved.agent, message);
    }
    fail(`${resolved.agent} run failed: ${message}`);
  }
}

async function commandWorker(argv) {
  const { options, positionals } = parseArgs(argv, { valueOptions: ['cwd'] });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const jobId = positionals[0];
  const job = readJob(cwd, jobId);
  if (!job) {
    fail(`Worker: job ${jobId} not found.`);
  }

  writeJob(cwd, jobId, { status: 'running', pid: process.pid });
  try {
    await executeTurnFor(job)(cwd, job, { echo: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJob(cwd, jobId, { status: 'failed', error: message });
    appendJobLog(cwd, jobId, { kind: 'error', message });
    process.exit(1);
  }
}

async function commandStatus(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['json'],
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const job = requireJob(cwd, positionals[0]);
  const pending = listPendingApprovals(resolveJobDir(cwd, job.id)).filter(
    approval => !approval.response,
  );
  const log = readJobLog(cwd, job.id, 6);
  printJson({
    jobId: job.id,
    status: job.status,
    agent: job.agent,
    threadId: job.threadId ?? null,
    turnId: job.turnId ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    pendingApprovals: pending.map(approval => ({ id: approval.id, summary: approval.summary })),
    recentProgress: log.map(entry => entry.message ?? entry.kind).filter(Boolean),
  });
}

async function commandResult(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['json'],
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const job = requireJob(cwd, positionals[0]);
  const resultFile = path.join(resolveJobDir(cwd, job.id), 'result.json');
  if (!fs.existsSync(resultFile)) {
    fail(`Job ${job.id} is ${job.status}; no result yet. Check: coder status ${job.id}`);
  }
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  if (options.json) {
    printJson(result);
    return;
  }
  process.stdout.write(`${result.finalMessage || '(no final message)'}\n`);
  if (result.touchedFiles?.length) {
    process.stderr.write(`[coder] touched files: ${result.touchedFiles.join(', ')}\n`);
  }
}

async function commandSteer(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ['cwd', 'model', 'effort', 'permissions'],
    booleanOptions: ['background', 'wait'],
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const [reference, ...promptParts] = positionals;
  const prompt = promptParts.join(' ').trim();
  if (!reference || !prompt) {
    fail('Usage: coder steer <job-id> "<follow-up instructions>" [--wait]');
  }
  const job = requireJob(cwd, reference);
  if (!job.threadId) {
    fail(`Job ${job.id} has no thread to steer yet (status: ${job.status}).`);
  }
  if (job.status === 'running') {
    fail(
      `Job ${job.id} is still running. Stop it first (coder stop ${job.id}) or wait, then steer.`,
    );
  }

  const forwarded = [
    prompt,
    '--resume',
    job.id,
    '--cwd',
    cwd,
    ...(job.agent ? ['--agent', job.agent] : []),
    ...(job.host && job.host !== 'claude' ? ['--host', job.host] : []),
    ...(options.model
      ? ['--model', options.model]
      : ['--model', job.model].filter(() => job.model)),
    ...(options.effort ? ['--effort', options.effort] : job.effort ? ['--effort', job.effort] : []),
    ...(options.permissions
      ? ['--permissions', options.permissions]
      : job.permissions
        ? ['--permissions', job.permissions]
        : []),
    ...(options.wait ? ['--wait'] : []),
  ];
  await commandTask(forwarded);
}

async function commandStop(argv) {
  const { options, positionals } = parseArgs(argv, { valueOptions: ['cwd'] });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const job = requireJob(cwd, positionals[0]);

  // Claude jobs have no app-server turn to interrupt; killing the worker
  // takes the claude child down with it (SIGTERM handler in claude-core).
  const interrupt =
    job.agent === 'claude'
      ? { detail: 'claude worker terminated' }
      : await interruptTurn(cwd, { threadId: job.threadId, turnId: job.turnId });
  if (job.pid && job.status === 'running') {
    try {
      process.kill(job.pid, 'SIGTERM');
    } catch {
      // Worker already exited.
    }
  }
  writeJob(cwd, job.id, { status: 'cancelled', completedAt: new Date().toISOString() });
  printJson({ jobId: job.id, status: 'cancelled', interrupt: interrupt.detail });
}

async function commandJobs(argv) {
  const { options } = parseArgs(argv, { valueOptions: ['cwd'] });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  printJson(
    listJobs(cwd).map(job => ({
      jobId: job.id,
      status: job.status,
      agent: job.agent,
      threadId: job.threadId ?? null,
      prompt: String(job.prompt ?? '').slice(0, 80),
      updatedAt: job.updatedAt,
    })),
  );
}

async function commandApprovals(argv) {
  const { options, positionals } = parseArgs(argv, { valueOptions: ['cwd'] });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const job = requireJob(cwd, positionals[0]);
  printJson(
    listPendingApprovals(resolveJobDir(cwd, job.id)).map(approval => ({
      id: approval.id,
      summary: approval.summary,
      createdAt: approval.createdAt,
      answered: approval.response?.decision ?? null,
    })),
  );
}

async function commandApprove(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['deny'],
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const [reference, approvalId] = positionals;
  if (!reference || !approvalId) {
    fail('Usage: coder approve <job-id> <approval-id> [--deny]');
  }
  const job = requireJob(cwd, reference);
  answerApproval(resolveJobDir(cwd, job.id), approvalId, options.deny ? 'decline' : 'accept');
  printJson({ jobId: job.id, approvalId, decision: options.deny ? 'decline' : 'accept' });
}

// coder config                      -> print effective config
// coder config get <key>            -> print one value (dotted path)
// coder config set <key> <value>    -> write to ~/.coder/config.json
// coder config unset <key>          -> remove an override
// --workspace targets <repo>/coder.config.json instead of the user file.
async function commandConfig(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['workspace'],
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const [action = 'list', key, ...valueParts] = positionals;
  const targetFile = options.workspace
    ? path.join(resolveWorkspaceRoot(cwd), 'coder.config.json')
    : resolveUserConfigFile();

  const getPath = (object, dotted) =>
    dotted.split('.').reduce((node, part) => (node == null ? undefined : node[part]), object);

  if (action === 'list') {
    printJson(loadConfig(cwd));
    return;
  }
  if (action === 'get') {
    if (!key) {
      fail('Usage: coder config get <key>  (e.g. chain, agents.codex.model)');
    }
    const value = getPath(loadConfig(cwd), key);
    printJson(value === undefined ? null : value);
    return;
  }
  if (action !== 'set' && action !== 'unset') {
    fail('Usage: coder config [get|set|unset] <key> [value] [--workspace]');
  }
  if (!key || (action === 'set' && valueParts.length === 0)) {
    fail(`Usage: coder config ${action} <key>${action === 'set' ? ' <value>' : ''}`);
  }

  const raw = valueParts.join(' ');
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    // Not JSON: comma lists become arrays ("codex,claude"), rest stay strings.
    value = raw.includes(',')
      ? raw
          .split(',')
          .map(part => part.trim())
          .filter(Boolean)
      : raw;
  }

  const current = fs.existsSync(targetFile) ? JSON.parse(fs.readFileSync(targetFile, 'utf8')) : {};
  const parts = key.split('.');
  let node = current;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) {
      node[part] = {};
    }
    node = node[part];
  }
  if (action === 'set') {
    node[parts.at(-1)] = value;
  } else {
    delete node[parts.at(-1)];
  }
  const errors = validateConfig(current);
  if (errors.length) {
    fail(`Refusing to write invalid config:\n  ${errors.join('\n  ')}`);
  }
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  printJson({
    file: targetFile,
    key,
    ...(action === 'set' ? { value } : { unset: true }),
    effective: getPath(loadConfig(cwd), key) ?? null,
  });
}

async function commandSetup(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['codex', 'claude', 'json'],
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();

  const availability = getCodexAvailability(cwd);
  const auth = availability.available
    ? await getCodexAuthStatus(cwd)
    : { loggedIn: false, detail: availability.detail };
  const claude = getClaudeAvailability();

  const configFile = resolveUserConfigFile();
  if (!fs.existsSync(configFile)) {
    // Seed the chain from what's installed. Codex is the recommended primary,
    // but when it's absent Claude leads so tasks work without installing Codex.
    // Neither installed => codex-first, so setup nudges the recommended install
    // (the Claude opus-subagent fallback still runs meanwhile under a claude host).
    const chain = availability.available
      ? ['codex', 'claude']
      : claude.available
        ? ['claude', 'codex']
        : ['codex', 'claude'];
    writeUserConfig({ ...DEFAULT_CONFIG, chain });
  }

  // --codex registers the packaged marketplace with codex and installs the
  // coder plugin from it, exactly what a user would type by hand.
  let codexPlugin = null;
  if (options.codex) {
    const marketplaceDir = fileURLToPath(new URL('..', import.meta.url));
    // Re-adding refreshes both the marketplace snapshot and the cached
    // plugin copy (codex caches installs per version).
    spawnSync('codex', ['plugin', 'remove', 'coder@coder'], { encoding: 'utf8' });
    spawnSync('codex', ['plugin', 'marketplace', 'remove', 'coder'], { encoding: 'utf8' });
    // Add as "." from inside the directory: codex parses "@" in a path
    // argument (node_modules/@wular/...) as a git owner/repo@ref source.
    const addMarketplace = spawnSync('codex', ['plugin', 'marketplace', 'add', '.'], {
      cwd: marketplaceDir,
      encoding: 'utf8',
    });
    const addPlugin = spawnSync('codex', ['plugin', 'add', 'coder@coder'], {
      encoding: 'utf8',
    });
    const installed = addMarketplace.status === 0 && addPlugin.status === 0;
    codexPlugin = {
      marketplace: marketplaceDir,
      installed,
      note: installed
        ? 'Plugin installed; restart any running codex session to load it.'
        : `Automatic install failed (${(addPlugin.stderr || addMarketplace.stderr || 'codex not found').trim()}); run: codex plugin marketplace add "${marketplaceDir}" && codex plugin add coder@coder`,
    };
  }

  // --claude does the same through the claude CLI's plugin commands.
  let claudePlugin = null;
  if (options.claude) {
    const marketplaceDir = fileURLToPath(new URL('..', import.meta.url));
    spawnSync('claude', ['plugin', 'marketplace', 'remove', 'coder'], { encoding: 'utf8' });
    const addMarketplace = spawnSync('claude', ['plugin', 'marketplace', 'add', marketplaceDir], {
      encoding: 'utf8',
    });
    const install = spawnSync('claude', ['plugin', 'install', 'coder@coder'], {
      encoding: 'utf8',
    });
    const installed = addMarketplace.status === 0 && install.status === 0;
    claudePlugin = {
      marketplace: marketplaceDir,
      installed,
      note: installed
        ? 'Plugin installed; restart any running Claude Code session to load it.'
        : `Automatic install failed (${(install.stderr || addMarketplace.stderr || 'claude not found').trim()}); run: claude plugin marketplace add "${marketplaceDir}" && claude plugin install coder@coder`,
    };
  }

  const config = loadConfig(cwd);
  const ready = availability.available && auth.loggedIn;

  if (options.json) {
    printJson({
      codex: {
        available: availability.available,
        detail: availability.detail,
        auth: auth.detail,
        loggedIn: auth.loggedIn,
      },
      claude: { available: claude.available, detail: claude.detail },
      configFile,
      runtime: fileURLToPath(new URL('../bin/coder.mjs', import.meta.url)),
      ...(codexPlugin ? { codexPlugin } : {}),
      ...(claudePlugin ? { claudePlugin } : {}),
      config,
      ready,
    });
    return;
  }

  const tty = process.stdout.isTTY && !process.env.NO_COLOR;
  const paint = (code, text) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
  const good = text => `  ${paint('32', '✔')} ${text}`;
  const bad = text => `  ${paint('31', '✘')} ${text}`;
  const head = text => paint('1', text);
  const gray = text => paint('38;5;245', text);

  const lines = [head('Coder setup'), ''];

  const codexLine = availability.available
    ? auth.loggedIn
      ? good(`codex   ${gray(`${availability.detail}; ${auth.detail}`)}`)
      : bad(`codex   not logged in ${gray(`(${auth.detail})`)} - run: codex login`)
    : bad(`codex   not installed - run: npm install -g @openai/codex`);
  const claudeLine = claude.available
    ? good(`claude  ${gray(claude.detail)}`)
    : bad(`claude  not installed - run: npm install -g @anthropic-ai/claude-code`);
  lines.push(head('Available Engines'), codexLine, claudeLine, '');

  const agentSummary = agent => {
    const entry = config.agents?.[agent] ?? {};
    return [entry.model, entry.effort, entry.permissions].filter(Boolean).join('/');
  };
  lines.push(
    head('Config'),
    `  chain: ${(config.chain ?? []).join(' -> ')}   codex: ${agentSummary('codex')}   claude: ${agentSummary('claude')}`,
    `  ${gray(configFile)} ${gray('(coder config set <key> <value> to change)')}`,
    '',
  );

  for (const [label, plugin] of [
    ['codex plugin ', codexPlugin],
    ['claude plugin', claudePlugin],
  ]) {
    if (plugin) {
      lines.push(
        plugin.installed ? good(`${label} ${gray(plugin.note)}`) : bad(`${label} ${plugin.note}`),
        '',
      );
    }
  }

  lines.push(
    ready
      ? good(`ready - try: coder task --wait "explain this repo's layout"`)
      : bad(
          `not ready - fix the engine issues above (tasks fall back to the claude engine meanwhile)`,
        ),
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}

const COMMANDS = {
  task: commandTask,
  _worker: commandWorker,
  status: commandStatus,
  result: commandResult,
  steer: commandSteer,
  stop: commandStop,
  jobs: commandJobs,
  approvals: commandApprovals,
  approve: commandApprove,
  config: commandConfig,
  setup: commandSetup,
};

function readVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    );
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand === '--version' || subcommand === '-v') {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }
  const handler = COMMANDS[subcommand];
  if (!handler) {
    const tty = process.stderr.isTTY && !process.env.NO_COLOR;
    const bold = text => (tty ? `\x1b[1m${text}\x1b[0m` : text);
    const cyan = text => (tty ? `\x1b[36m${text}\x1b[0m` : text);
    // 256-color mid gray: legible on dark and light themes, unlike faint (2m).
    const dim = text => (tty ? `\x1b[38;5;245m${text}\x1b[0m` : text);
    const row = (left, right) => `  ${cyan(left.padEnd(34))}${dim(right)}`;
    fail(
      [
        `${bold('Coder')}`,
        '',
        bold('Usage:'),
        '  coder <command> [flags]',
        '',
        bold('Commands:'),
        row('task "<text>" [--wait]', 'run a coding task (background; --wait blocks)'),
        row('status [job]', 'job status, progress, pending approvals'),
        row('result [job]', 'final message of a finished job'),
        row('steer <job> "<follow-up>"', "continue a job's thread with new instructions"),
        row('stop <job>', 'interrupt a running job'),
        row('jobs', 'list jobs for this workspace'),
        row('approvals <job>', 'list escalated approvals'),
        row('approve <job> <id> [--deny]', 'answer an escalated permission'),
        row(
          'config [get|set|unset] <key> [value]',
          'read or write config (e.g. set chain claude,codex)',
        ),
        row('setup [--claude|--codex]', 'check engines, write config, install the host plugin'),
        row('--version, -v', 'print the coder version'),
        '',
        bold('Task flags:') + dim(' (task and steer)'),
        row('--agent <codex|claude>', 'engine (default: first in configured chain)'),
        row('--model <alias|slug>', 'spark, 5.5 (codex) | opus, sonnet, fable (claude); alias picks engine'),
        row('--effort <low|medium|high>', 'reasoning effort'),
        row('--permissions <mode>', 'read-only | workspace-write | auto (default: auto)'),
        row('--resume <job>', "continue that job's thread instead of starting fresh"),
        '',
        row('--cwd <dir>', 'workspace directory, any command (default: current)'),
      ].join('\n'),
    );
  }
  await handler(argv);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
