import path from 'node:path';
import process from 'node:process';

import * as z from 'zod/mini';

import { baseOptions, parseArgs, str } from '../lib/args.js';
import { resolveJobDir } from '../lib/state.js';
import { runTurn } from '../lib/codex-core.js';
import { runClaudeTurn } from '../lib/claude-core.js';
import { isEndpointModel, loadConfig, resolveCodexModel, resolveCustomModel } from '../lib/config.js';
import { startChatBridge } from '../lib/chat-bridge.js';
import { fail, outStyle, printJson, requireJob, resolveCwd } from '../lib/ui.js';
import type { Effort, Job, TurnResult } from '../lib/types.js';

// Read-only sidecar: answers ABOUT a task from its on-disk state, never
// touching its thread or creating a task record.
function sidecarPrompt(job: Job, jobDir: string, question: string): string {
  const meta = [
    `id: ${job.id}`,
    ...(job.name ? [`name: ${job.name}`] : []),
    `status: ${job.status}`,
    `agent: ${job.agent}${job.model ? `/${job.model}` : ''}${job.effort ? `/${job.effort}` : ''}`,
    ...(job.cwd ? [`workspace: ${job.cwd}`] : []),
    ...(job.createdAt ? [`created: ${job.createdAt}`] : []),
    ...(job.completedAt ? [`finished: ${job.completedAt}`] : []),
  ].join('\n');
  return `You are a read-only sidecar answering a question ABOUT a coder task.
You are not the task: never continue, redo, or fix its work — only answer the question. The task never sees this question or your answer.

Task metadata:
${meta}

Task prompt:
${job.prompt ?? '(unknown)'}

Inspect as needed (grep/read selectively; events can be large):
- progress log (jsonl, one event per line): ${path.join(jobDir, 'log.jsonl')}
- final result: ${path.join(jobDir, 'result.json')}
- worker output: ${path.join(jobDir, 'worker.log')}
${job.cwd ? `- the task's workspace (its code and changes): ${job.cwd}` : ''}

Question: ${question}

Answer the question directly and concisely.`;
}

// Print-free core (SDK `task.ask`).
export async function askTaskCore(
  cwd: string,
  job: Job,
  question: string,
  opts: { model?: string; effort?: string } = {},
): Promise<TurnResult> {
  const jobDir = resolveJobDir(cwd, job.id);
  const prompt = sidecarPrompt(job, jobDir, question);
  const effort = (opts.effort ?? job.effort ?? null) as Effort | null;
  if (job.engine === 'claude') {
    return runClaudeTurn(job.cwd ?? cwd, {
      prompt,
      model: opts.model ?? job.model,
      effort,
      permissions: 'read-only',
    });
  }
  const config = loadConfig(cwd);
  const name = opts.model ?? job.model;
  const entry = name ? config.models?.[name] : undefined;
  const customEntry = entry && isEndpointModel(entry) ? entry : undefined;
  if (customEntry?.envKey && !process.env[customEntry.envKey]) {
    throw new Error(`Missing environment variable: \`${customEntry.envKey}\`.`);
  }
  const bridge = customEntry
    ? await startChatBridge(customEntry, customEntry.wireApi ?? 'chat')
    : null;
  const custom = resolveCustomModel(config, name, bridge ?? undefined);
  try {
    return await runTurn(job.cwd ?? cwd, {
      prompt,
      model: custom?.model ?? resolveCodexModel(name ?? null),
      modelProvider: custom?.modelProvider ?? null,
      configOverrides: custom?.configOverrides ?? null,
      effort,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      ephemeral: true,
    });
  } finally {
    await bridge?.close();
  }
}

export async function commandAsk(argv: string[]): Promise<void> {
  const { options, positionals } = parseArgs(
    argv,
    z.object({ ...baseOptions, model: str, effort: str }),
  );
  const cwd = resolveCwd(options);
  const [reference, ...questionParts] = positionals;
  const question = questionParts.join(' ').trim();
  if (!reference || !question) {
    fail('Missing task id or question.', {
      hint: ['Usage: coder task ask <task-id> "<question>"', 'Help: coder task ask --help'],
    });
  }
  const job = requireJob(cwd, reference);

  if (!options.json) {
    process.stderr.write(
      `${outStyle.dim('[coder]')} asking about task ${outStyle.cyan(job.id)} (read-only sidecar; the task is not interrupted)...\n`,
    );
  }
  const result = await askTaskCore(cwd, job, question, {
    model: options.model,
    effort: options.effort,
  });
  const answer = result.finalMessage || '';
  if (options.json) {
    printJson({
      taskId: job.id,
      answer: answer || null,
      ...(result.error ? { error: result.error.message } : {}),
    });
  } else if (answer) {
    process.stdout.write(`\n${answer}\n`);
  } else {
    const errorNote = result.error?.message ? ` ${outStyle.red(result.error.message)}` : '';
    process.stdout.write(`${outStyle.dim('(no answer)')}${errorNote}\n`);
  }
  process.exitCode = result.status === 0 ? 0 : 1;
}
