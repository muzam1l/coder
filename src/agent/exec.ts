import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import type { ChildProcess } from 'node:child_process';
import { defaultEmojiResolver, type Message, type Thread } from 'chat';

import { resolveFlow } from '../flow/discover';
import { runFlowByName } from '../flow/executor';
import { loadConfig } from '../core/config';
import {
  CoderError,
  dispatchTask,
  selectMcpServers,
  resolveTaskOptions,
  waitTask,
  capPermissions,
  resolveMcpServers,
  turnFallbackEngine,
  type DispatchOptions,
  type TaskResult,
} from '../core/dispatch';
import { EMPTY_MESSAGE, EMPTY_MESSAGE_NOTICE, SKIPPED } from '../core/defaults';
import {
  watchTask,
  appendTaskLog,
  loadTask as loadTaskRecord,
  readTurnResults,
  resolveTaskDir,
  generateTaskId,
  writeTask,
  type TurnResultEntry,
} from '../core/state';
import { heldConnections, steerTask } from '../core/task/actions';
import type { McpServerSpec, Task } from '../core/types';
import type { Integration } from '../integrations/types';
import type { Replies } from '../server/tasks/events';
import {
  definitionEvents,
  effectiveSettings,
  parseAgentDefinition,
  resolveTools,
} from './definition';
import { loadAgents } from './load';
import { postReview, resolveReviewTarget, REVIEW_PLATFORM } from '../flow/builtin/review';
import { INTEGRATIONS } from '../integrations';
import { nativeToolEnvironment, tokenEnvName, toolServerToken, type ReplyEndpoint } from './mcp';
import type { Agent, AgentEvent, AgentTask, TaskContext, TaskSource } from './types';
import { serveMailbox, agentMailboxDir } from '../core/mailbox';
import {
  developerInstructions,
  eventPrompt,
  historyPrompt,
  requestPrompt,
  type AgentPromptParts,
} from '../core/prompts';
import { connectionEnvironment, localConnections, narrowConnections } from '../core/connections';
import { replyRequired } from '../core/event-prompt';
import { readJsonFile, writeJsonFileAtomic } from '../utils/fsx';

/** Names the local engine task an agent task runs on, so listings can tell them apart. */
export const AGENT_TASK_PREFIX = 'agent:';

/** A task for a local `--event` run: the event integration's tools only. */
export function taskFromEvent(agent: Agent, flow: string, event: AgentEvent): AgentTask {
  const integration = INTEGRATIONS[event.integration];
  return {
    id: `local-${event.deliveryId}-${agent.id}`,
    source: event.integration as TaskSource,
    agent: agent.id,
    flow,
    runner: 'local',
    event,
    definition: agent.definition,
    ...(agent.usage ? { usage: agent.usage } : {}),
    tools: integration
      ? {
          [event.integration]: resolveTools(agent, event.integration, integration),
        }
      : {},
  };
}

function normalizedReply(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[“”„‟«»‘’‚‛"'`]/g, '')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/[.!?,;:…]+(?=\s|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The turn's reply, including skipped answers, missing answers and failures. */
export function threadReply(
  task: Pick<AgentTask, 'event' | 'context' | 'failureReply' | 'taskUrl'>,
  result: { finalMessage?: string | null; error?: { message?: string } | null } | null | undefined,
  cancelled: boolean,
  turn?: Pick<TurnResultEntry, 'prompt' | 'steers' | 'lastReply'>,
): { text: string; problem: boolean; skipped?: true; duplicate?: boolean } {
  const answer = result?.finalMessage?.trim();
  const progress = task.event && INTEGRATIONS[task.event.integration]?.progressReplies;
  const lastReply = turn?.lastReply?.trim();
  // Claude Code reports its own errors as the final message; a failed run gets the failure text instead.
  if (answer && answer.replace(/^`+|`+$/g, '').trim() !== EMPTY_MESSAGE && !result?.error)
    return {
      text: answer,
      problem: false,
      ...(!progress && lastReply && normalizedReply(answer) === normalizedReply(lastReply)
        ? { duplicate: true } : {}),
    };
  const error = result?.error?.message?.trim() ?? '';
  if (result?.error && lastReply && !progress) return { text: '', problem: true, duplicate: true };
  if (cancelled) return { text: error, problem: false };
  if (result && !result.error) {
    if (progress && lastReply) return { text: lastReply, problem: false };
    if (
      turn?.lastReply?.trim() ||
      replyRequired(
        turn?.prompt,
        task.context?.mustReply ?? task.event?.mustReply,
        turn?.steers,
      ) === false
    )
      return { text: '', problem: false, skipped: true };
    const link = task.taskUrl ? ` [See the task](${task.taskUrl})` : '';

    return { text: `${EMPTY_MESSAGE_NOTICE}${link}`, problem: false };
  }

  return { text: task.failureReply ?? error, problem: true };
}

/** An adapter that can mark a reply as a failure, as Linear's error activity does. */
type ProblemAdapter = { postProblem?(threadId: string, text: string): ReturnType<Replies['post']> };

type ProgressAdapter = { postProgress?(threadId: string, text: string): Promise<{ id: string }> };

/** Split replies at paragraph boundaries where the platform's limit allows. */
export function replyParts(text: string, limit?: number): string[] {
  if (!limit || text.length <= limit) return [text];
  const parts: string[] = [];
  let part = '';
  let fenced = false;
  const push = () => {
    if (part.trim()) parts.push(part.trimEnd());
    part = '';
  };
  for (const paragraph of text.split(/\n\n/)) {
    if (part && !fenced && `${part}\n\n${paragraph}`.length > limit) push();
    let grown = part ? `${part}\n\n${paragraph}` : paragraph;
    // Still too long, so a paragraph or fence alone passes the limit: cut on lines, then on characters.
    while (grown.length > limit) {
      const cut = grown.lastIndexOf('\n', limit);
      const at = cut > 0 ? cut : limit;
      parts.push(grown.slice(0, at).trimEnd());
      grown = grown.slice(at).replace(/^\n/, '');
    }
    part = grown;
    if ((paragraph.match(/^```/gm) ?? []).length % 2 === 1) fenced = !fenced;
  }
  push();

  return parts;
}

export async function postReplyParts(
  thread: Thread,
  text: string,
  limit?: number,
  message?: Message | string,
  progress = false,
) {
  const sent: { id: string }[] = [];
  const ongoing = progress && (thread.adapter as ProgressAdapter).postProgress;
  for (const part of replyParts(text, limit))
    sent.push(
      ongoing
        ? await ongoing.call(thread.adapter, thread.id, part)
        : message && thread.adapter.reply
          ? await thread.reply(message, { markdown: part })
          : await thread.post({ markdown: part }),
    );

  return sent;
}

/** Post into the event's Chat SDK thread through its integration's adapter, on the task's own token. */
export async function postReply(
  integration: Integration,
  event: AgentEvent,
  text: string,
  token: string,
  author = integration.id,
  problem = false,
  progress = false,
  prepared?: Thread,
): Promise<string[]> {
  const thread = prepared ?? (await eventThread(integration, event, token, author));
  const adapter = thread.adapter;
  const marks = (adapter as ProblemAdapter).postProblem;
  if (problem && marks) {
    const sent = await marks.call(adapter, thread.id, text);
    const id = sent?.id;

    return id ? [id] : [];
  }
  // Send Markdown through the platform adapter.
  const messages = await postReplyParts(
    thread,
    text,
    integration.replyLimit,
    event.chat?.message?.id,
    progress,
  );

  return messages.flatMap(sent => (sent.id ? [sent.id] : []));
}

/** A durable send intent prevents replay of an ambiguous platform response after a crash. */
export async function postTurnReply(
  cwd: string,
  taskId: string,
  turn: number,
  send: () => Promise<string[]>,
): Promise<string[]> {
  const file = path.join(resolveTaskDir(cwd, taskId), `post-${turn}.json`);
  const receipt = readJsonFile<string[]>(file);
  if (receipt) return receipt;
  writeFileSync(file, 'null', { flag: 'wx' });
  const ids = await send();
  writeJsonFileAtomic(file, ids);

  return ids;
}

async function eventThread(
  integration: Integration,
  event: AgentEvent,
  token: string,
  author: string,
) {
  if (!event.chat) throw new Error(`The ${event.integration} event has no conversation`);
  const [{ Chat }, { LocalChatState }] = await Promise.all([
    import('chat'),
    import('../server/store/chat'),
  ]);
  const adapter = await integration.adapter({
    fetch,
    appId: event.appId.slice(integration.id.length + 1),
    name: author,
    installationId: event.installationId,
    token: async () => token,
    privateState: () => new LocalChatState(),
  });
  const chat = new Chat({
    userName: author,
    adapters: { [integration.id]: adapter },
    state: new LocalChatState(),
    logger: 'error',
  });
  await chat.initialize();

  return chat.thread(event.chat.thread.id);
}

export async function reactToMessage(thread: Thread, emoji: string, message?: string) {
  if (!message) throw new Error('This turn has no message to react to; give a message id');
  const normalized = defaultEmojiResolver.fromSlack(defaultEmojiResolver.fromGChat(emoji).name);
  await thread.adapter.addReaction(thread.id, message, normalized);
}

/** Add the app's reaction through the same adapter and token as its replies. */
export async function postReaction(
  integration: Integration,
  event: AgentEvent,
  emoji: string,
  token: string,
  author = integration.id,
  message = event.chat?.message?.id,
): Promise<void> {
  const thread = await eventThread(integration, event, token, author);
  await reactToMessage(thread, emoji, message);
}

/** Local runs carry tokens in `APP_TOKEN_<ID>`, or `APP_TOKEN` for the event integration. */
function localTokens(task: AgentTask, env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.keys(task.tools).map(id => [
      id,
      env[tokenEnvName(id)] ?? (id === task.event?.integration ? env.APP_TOKEN : undefined),
    ]),
  );
}

export interface ExecResult {
  ok: boolean;
  flow: string;
  /** Default flow: the engine's answer, posted to the platform unless `post` was false. */
  reply?: string;
  posted?: boolean;
  postedMessages?: string[];
  taskId?: string;
  turn?: number;
  runId?: string;
  result?: unknown;
  tokens?: unknown;
}

export async function execAgent(options: {
  cwd: string;
  agent: string;
  flow: string;
  task?: AgentTask;
  taskFile?: string;
  taskId?: string;
  eventFile?: string;
  /** Post the default flow's reply to the platform (default true). */
  post?: boolean;
  resumeTaskId?: string;
  resumeTurn?: number;
  /** An engine conversation saved by an earlier turn, continued instead of starting a new one. */
  resume?: DispatchOptions['resume'];
  onTask?: (taskId: string, turn?: number) => void | Promise<void>;
  onWorker?: DispatchOptions['onWorker'];
  availability?: DispatchOptions['availability'];
  onEngine?: (engine: string) => Promise<boolean | void>;
  onStart?: import('../flow/runtime').FlowHooks['onStart'];
  /** Secrets passed only to task-core MCP children, never inherited by the engine. */
  toolEnvironment?: { tokens: Record<string, string> };
  /** Where the conversation tools post, when the caller posts replies for the task. */
  replyEndpoint?: ReplyEndpoint;
  connections?: Record<string, McpServerSpec>;
  connectionEnv?: Record<string, string>;
  postToken?: string;
  onApproval?: (approval: unknown) => void | Promise<void>;
  /** Run as a listed CLI task started from here, instead of a runner's hidden engine task. */
  source?: TaskSource;
}): Promise<ExecResult> {
  const { cwd, flow } = options;
  const config = loadConfig(cwd);
  const agents = await loadAgents(cwd, INTEGRATIONS);
  let task = options.task;
  if (!task && options.taskFile)
    task = {
      ...(JSON.parse(await fs.readFile(path.resolve(cwd, options.taskFile), 'utf8')) as AgentTask),
      flow,
    };
  let agent = agents.find(candidate => candidate.id === options.agent);
  if (task) {
    agent = {
      id: task.agent,
      name: task.definition.name ?? task.agent,
      definition: parseAgentDefinition(task.agent, task.definition),
      ...(task.usage ? { usage: task.usage } : {}),
      ...(task.files ? { files: task.files } : {}),
      builtin: false,
    };
  }
  if (!agent) throw new Error(`No agent named "${options.agent}".`);
  task ??= await loadTask(cwd, agent, flow, options);
  const event = task.event;
  const integration = event && INTEGRATIONS[event.integration];
  if (event && !integration) throw new Error(`Unknown integration "${event.integration}".`);
  const connected = connectionEnvironment(options.connections ?? {}, options.connectionEnv);

  const native = nativeToolEnvironment(
    task,
    options.toolEnvironment?.tokens ?? localTokens(task, process.env),
    options.replyEndpoint,
  );

  if (flow === 'default') {
    const posting = options.post !== false && Boolean(integration);
    const token = options.postToken ?? process.env.APP_TOKEN!;
    const prepared = posting
      ? eventThread(integration!, event!, token, task.author ?? integration!.id)
      : undefined;
    void prepared?.catch(() => {});
    const defaults = defaultTask(agent, task);
    const resumedEngine = options.resumeTaskId && loadTaskRecord(cwd, options.resumeTaskId)?.engine;
    let resolved = resolveTaskOptions(
      resumedEngine && resumedEngine !== effectiveSettings(agent).engine
        ? { engine: resumedEngine }
        : effectiveSettings(agent),
      config,
    );
    const selectedMcp = selectMcpServers(
      task.mcp?.join(','),
      config.mcp,
      agent.definition.mcp,
      connected.mcp,
    );
    const mcp = [...Object.values(native.mcp), ...selectedMcp.mcp];
    let first =
      options.resumeTurn ??
      (options.resumeTaskId ? readTurnResults(cwd, options.resumeTaskId).length : 0);
    let worker: ChildProcess | undefined;
    const engineTaskId = options.resumeTaskId ?? options.taskId ?? generateTaskId();
    const chain = task.engineChain ?? [resolved.engine];
    let index = Math.max(0, chain.indexOf(resolved.engine));
    let retry = false;
    for (const engine of chain.slice(0, index))
      appendTaskLog(cwd, engineTaskId, {
        kind: 'warning',
        message: `${engine} skipped because no applicable credential is connected`,
      });
    let dispatched!: { taskId: string };
    let completed!: TaskResult;
    for (;;) {
      const engine = chain[index]!;
      resolved = resolveTaskOptions(
        retry ? { engine } : { ...effectiveSettings(agent), engine },
        config,
      );
      let startupFailure = false;
      try {
        if ((await options.onEngine?.(engine)) === false)
          throw new CoderError(
            'chain-exhausted',
            `No applicable credential is connected for ${engine}`,
          );
        if (retry)
          writeTask(cwd, engineTaskId, {
            status: 'queued',
            pid: null,
            threadId: null,
            resumeThreadId: null,
            resumedAt: new Date().toISOString(),
            error: undefined,
            completedAt: undefined,
          });
        dispatched = options.resumeTaskId
          ? { taskId: options.resumeTaskId }
          : await dispatchTask(
              {
                onWorker: (id, child) => {
                  worker = child;
                  options.onWorker?.(id, child);
                },
                availability: options.availability,
                taskId: engineTaskId,
                ...(options.resume ? { resume: options.resume } : {}),
                mcp,
                mcpBindings: selectedMcp.mcpBindings,
                mcpWarnings: selectedMcp.warnings,
                nativeMcp: selectedMcp.nativeMcp,
                connectionEnv: { ...connected.env, ...native.env },
                connections: task.connections,
                cwd,
                agentId: task.agent,
                // Platform conversations roll over; dashboard and CLI tasks keep the engine's own compaction.
                ...(isConversation(task) ? { conversation: true } : {}),
                ...(task.author ? { author: task.author } : {}),
                ...(event?.repo ? { repo: `${event.repo.owner}/${event.repo.name}` } : {}),
                ...(options.source
                  ? { source: options.source }
                  : { name: `${AGENT_TASK_PREFIX}${task.id}`, source: task.source }),
                engine: resolved.engine,
                model: resolved.model ?? undefined,
                effort: resolved.effort ?? undefined,
                permissions: task.permissions ?? resolved.permissions,
                agentPrompt: defaults.agentPrompt,
                prompt: defaults.prompt,
                outputSchema: task.context?.outputSchema,
                wait: true,
              },
              task.engineChain
                ? { config: { ...config, chain: [resolved.engine] }, waitForStartup: false }
                : {},
            );
        await options.onTask?.(dispatched.taskId, first);
        completed = await waitForAgentTask(cwd, dispatched.taskId, options.onApproval, (cwd, id) =>
          waitTask(cwd, id, { turn: first, worker }),
        );
      } catch (error) {
        if (!task.engineChain || !(error instanceof CoderError) || error.code !== 'chain-exhausted')
          throw error;
        startupFailure = true;
        const detail = error.payload?.error ?? error.message;
        const record = writeTask(cwd, engineTaskId, {
          status: 'failed',
          engine: resolved.engine,
          prompt: defaults.prompt,
          error: detail,
          pid: null,
        });
        const result = { status: 1, threadId: null, error: { message: detail } };
        writeJsonFileAtomic(path.join(resolveTaskDir(cwd, record.id), 'result.json'), result);
        await fs.appendFile(
          path.join(resolveTaskDir(cwd, record.id), 'results.jsonl'),
          JSON.stringify({ ...result, prompt: defaults.prompt }) + '\n',
        );
        dispatched = { taskId: record.id };
        await options.onTask?.(record.id, first);
        completed = {
          taskId: record.id,
          task: record,
          status: 'failed',
          result,
          turns: readTurnResults(cwd, record.id),
          steps: [],
        };
      }
      const next = startupFailure
        ? (chain[index + 1] ?? null)
        : task.engineChain
          ? turnFallbackEngine(cwd, completed, { ...config, chain: chain as typeof config.chain })
          : undefined;
      if (next !== undefined)
        appendTaskLog(cwd, engineTaskId, {
          kind: 'warning',
          message: `${resolved.engine} skipped because ${completed.result?.error?.message ?? 'the engine could not start'}`,
        });
      if (next === undefined || next === null) break;
      first = readTurnResults(cwd, dispatched.taskId).length;
      if (worker)
        await new Promise<void>(resolve => {
          if (worker!.exitCode !== null || worker!.signalCode) return resolve();
          worker!.once('exit', () => resolve());
        });
      index++;
      retry = true;
      options = { ...options, resumeTaskId: undefined, resume: undefined };
    }
    // This turn's own answer: later turns are posted by whoever waits for them.
    const turn = readTurnResults(cwd, dispatched.taskId)[first];
    const {
      text: reply,
      problem,
      skipped,
      duplicate,
    } = turn
      ? threadReply(task, turn, false, turn)
      : threadReply(task, completed.result, completed.status === 'cancelled');
    if (skipped && posting)
      appendTaskLog(cwd, dispatched.taskId, { kind: 'status', message: SKIPPED });
    const posted = posting && Boolean(reply) && !duplicate;
    const postedMessages = posted
      ? await postTurnReply(cwd, dispatched.taskId, first, async () =>
          postReply(
            integration!,
            event!,
            reply,
            token,
            task.author,
            problem,
            false,
            await prepared,
          ),
        )
      : [];

    return {
      ok: completed.status === 'completed',
      flow,
      reply,
      posted,
      ...(postedMessages.length ? { postedMessages } : {}),
      taskId: dispatched.taskId,
      turn: first,
      tokens: completed.result?.tokens ?? undefined,
    };
  }

  const resolved = resolveFlow(flow, cwd);
  const args =
    resolved.scope === 'builtin'
      ? {
          ...(await builtinTaskArgs(task, agent, options.post !== false)),
          cwd,
          ...task.args,
        }
      : (task.args ?? event);
  const run = await runFlowByName(
    resolved.path,
    {
      cwd,
      ...(options.taskId ? { runId: options.taskId } : {}),
      args,
      ceiling: {
        agent: agent.id,
        permissions:
          task.permissions ?? resolveTaskOptions(effectiveSettings(agent), config).permissions,
      },
      ...(options.postToken ? { integrationToken: options.postToken } : {}),
      connections: {
        mcp: { ...connected.mcp, ...native.mcp },
        env: { ...connected.env, ...native.env },
        ids: task.connections ?? [],
      },
    },
    {
      ...(options.onTask
        ? {
            onEvent: (event: import('../flow/types').FlowEvent) => {
              if (event.kind === 'task-start') options.onTask!(event.taskId);
            },
          }
        : {}),
      ...(options.onStart ? { onStart: options.onStart } : {}),
    },
  );
  return {
    ok: true,
    flow,
    runId: run.runId,
    result: run.result,
    tokens: run.tokens,
  };
}

export async function waitForAgentTask(
  cwd: string,
  taskId: string,
  onApproval?: (approval: unknown) => void | Promise<void>,
  wait: typeof waitTask = waitTask,
  pause?: () => Promise<void>,
) {
  let reportedId: string | undefined;
  const changes = watchTask(cwd, taskId);
  try {
    for (;;) {
      try {
        return await wait(cwd, taskId);
      } catch (error) {
        if (!(error instanceof CoderError) || error.code !== 'approval-pending' || !onApproval)
          throw error;
        if (error.approval?.id !== reportedId) {
          reportedId = error.approval?.id;
          await onApproval(error.approval);
          continue;
        }
        await (pause ? pause() : changes.wait(30000));
      }
    }
  } finally {
    changes.close();
  }
}

/** Build flow arguments from the immutable task, including its matched permission and author. */
export async function builtinTaskArgs(
  task: AgentTask,
  agent: Agent,
  post = true,
): Promise<Record<string, unknown>> {
  if (!task.event) throw new Error('built-in flows need a GitHub pull request event');
  return {
    ...(await builtinArgs(task.event, agent, task.context, task.author, post)),
    ...effectiveSettings(agent),
    ...(task.permissions ? { permissions: task.permissions } : {}),
  };
}

/** `--task` carries the whole AgentTask; `--event` derives one for local runs. */
async function loadTask(
  cwd: string,
  agent: Agent,
  flow: string,
  options: { taskFile?: string; eventFile?: string },
): Promise<AgentTask> {
  if (options.taskFile) {
    const task = JSON.parse(
      await fs.readFile(path.resolve(cwd, options.taskFile), 'utf8'),
    ) as AgentTask;
    return { ...task, flow, tools: task.tools ?? {} };
  }
  if (!options.eventFile) throw new Error('Missing --task or --event file.');
  const event = JSON.parse(
    await fs.readFile(path.resolve(cwd, options.eventFile), 'utf8'),
  ) as AgentEvent;
  return taskFromEvent(agent, flow, event);
}

/** Built-in flow args from an agent event: the pull request its integration names becomes `{ pr, post }`. */
export function builtinArgs(
  event: AgentEvent,
  agent: Agent,
  context?: TaskContext,
  author?: string,
  post = true,
): Record<string, unknown> {
  const pr = INTEGRATIONS[event.integration]?.repos?.pullRequest(event);
  if (!pr) throw new Error('built-in flows need a pull request event');
  return {
    pr,
    post,
    ...(author ? { author } : {}),
  };
}

/** Task options from a local agent definition: `coder task run --agent <id>`. */
export async function agentTaskOptions(
  cwd: string,
  id: string,
  mcpFlag?: string,
  connections?: Record<string, McpServerSpec>,
  narrowed?: string[],
): Promise<{
  engine?: string;
  model?: string;
  effort?: string;
  permissions?: string;
  developer: string;
  mcp: McpServerSpec[];
  mcpBindings?: Task['mcpBindings'];
  nativeMcp: boolean;
  warnings?: string[];
  mcpWarnings?: string[];
  connections?: string[];
  connected?: Awaited<ReturnType<typeof localConnections>>;
}> {
  const agents = await loadAgents(cwd, INTEGRATIONS);
  const agent = agents.find(a => a.id === id);
  if (!agent)
    throw new CoderError('invalid-option', `No agent named "${id}".`, {
      hint: `Agents here: ${agents.map(a => a.id).join(', ')}`,
    });
  const { definition, usage } = agent;
  const connected =
    connections === undefined
      ? await localConnections(narrowConnections(usage?.connections, narrowed))
      : undefined;
  const own = definition.mcp ?? {};
  const mcp = selectMcpServers(mcpFlag, loadConfig(cwd).mcp, own, connections ?? connected?.mcp);

  return {
    engine: usage?.engine ?? definition.engine,
    model: usage?.model ?? definition.model,
    effort: usage?.effort ?? definition.effort,
    permissions: usage?.permissions ?? definition.permissions,
    developer: agentDeveloperInstructions(agent),
    ...mcp,
    mcpWarnings: mcp.warnings,
    connections: usage?.connections,
    ...(connected ? { connected } : {}),
  };
}

const MAX_SYSTEM_CHARS = 48_000;

/** The developer's part of the system prompt: what whoever built the agent wrote, plus the installation's repository instructions. */
export function agentDeveloperInstructions(agent: Agent, context?: TaskContext): string {
  return developerInstructions({
    description: agent.definition.description,
    instructions: agentInstructions(agent),
    repositoryInstructions: context?.instructions,
    repository: context?.repository,
  });
}

export function agentInstructions(agent: Agent): string {
  if (!agent.dir) return filesInstructions(agent.files ?? {});
  let files: string[];
  try {
    files = readdirSync(agent.dir).filter(file => file.endsWith('.md'));
  } catch {
    return '';
  }
  files.sort((a, b) => {
    if (a === 'system.md') return -1;
    if (b === 'system.md') return 1;
    return a.localeCompare(b);
  });
  let output = '';
  for (const file of files) {
    const section = `### ${file}\n\n${readFileSync(path.join(agent.dir, file), 'utf8').trim()}\n`;
    output += section.slice(0, MAX_SYSTEM_CHARS - output.length);
    if (output.length === MAX_SYSTEM_CHARS) break;
  }
  return output.trimEnd();
}

function filesInstructions(files: Record<string, string>): string {
  const markdown = Object.keys(files).filter(file => file.endsWith('.md'));
  markdown.sort((a, b) => {
    if (a === 'system.md') return -1;
    if (b === 'system.md') return 1;
    return a.localeCompare(b);
  });
  let output = '';
  for (const file of markdown) {
    const section = `### ${file}\n\n${files[file]!.trim()}\n`;
    output += section.slice(0, MAX_SYSTEM_CHARS - output.length);
    if (output.length === MAX_SYSTEM_CHARS) break;
  }
  return output.trimEnd();
}

/** A platform event's own task is a conversation; dashboard and CLI tasks are reports. */
export const isConversation = (task: Pick<AgentTask, 'event' | 'source'>) =>
  Boolean(task.event && task.source === task.event.integration);

export function defaultTask(
  agent: Agent,
  task: Pick<AgentTask, 'event' | 'prompt' | 'context' | 'source' | 'tools'>,
): { agentPrompt: AgentPromptParts; prompt: string } {
  const { event, context } = task;
  const conversation = isConversation(task);
  const user = task.prompt === undefined ? context?.user : undefined;
  const integration = event && INTEGRATIONS[event.integration];
  const turn =
    task.prompt === undefined
      ? event
        ? eventPrompt([event], user)
        : ''
      : requestPrompt(task.prompt, event?.repo, event && integration?.repos?.pullRequest(event));

  return {
    agentPrompt: {
      developer: agentDeveloperInstructions(agent, context),
      ...(conversation
        ? {
            platform: { name: event!.integration, prompt: integration?.prompt },
            events: definitionEvents(agent.definition.integrations[event!.integration]),
          }
        : {}),
      ...(task.tools ? { tools: task.tools } : {}),
    },
    prompt: historyPrompt(context?.messages ?? [], turn),
  };
}

export function startAgentMailbox(cwd: string, task: Task): () => void {
  const dir = agentMailboxDir(cwd, task);
  if (!dir) return () => {};
  const ceiling = { agent: task.agentId!, permissions: task.permissions ?? 'auto' };
  const launchCwd = realpathSync(cwd);
  const authorizedMcp = new Map((task.mcp ?? []).map(server => [server.name, server] as const));
  const connectionSource = task.connectionSource ?? (task.connections ? 'server' : undefined);
  // Pinned to the parent's launch directory when a request picks it, so a mailbox cwd cannot swap it.
  const pinned = (server: McpServerSpec) => {
    if (!server.command) return server;
    const [resolved] = resolveMcpServers([server], process.env, launchCwd);
    if (!resolved) throw new Error(`MCP server "${server.name}" is not approved.`);

    return { ...server, command: resolved!.command, args: resolved!.args };
  };

  // Canonical paths on both sides, so a symlink inside the workspace cannot point a task outside it.
  const real = (target: string) => {
    try {
      return realpathSync(target);
    } catch {
      return null;
    }
  };
  const roots = [cwd, ...(task.addDirs ?? [])].flatMap(root => real(path.resolve(root)) ?? []);
  const inside = (target: string) =>
    roots.some(root => target === root || target.startsWith(root + path.sep));
  const started = new Map<string, string>();
  const pulls = new Set<string>();
  const auth = () => {
    const token = toolServerToken(resolveMcpServers(task.mcp), REVIEW_PLATFORM);
    return token ? { token } : {};
  };

  return serveMailbox(dir, {
    async dispatch(p) {
      const name = p.name ?? 'task';
      if (p.mcp !== undefined && (typeof p.mcp !== 'string' || /^[\[{]/.test(p.mcp.trim())))
        throw new CoderError('invalid-option', 'Mailbox MCP selections must be server names.');

      const selection: string = p.mcp ?? '';
      const mcp = selection
        .split(',')
        .map(name => name.trim())
        .filter(Boolean)
        .map(name => {
          const server = name === 'all' ? undefined : authorizedMcp.get(name);
          if (!server)
            throw new CoderError(
              'invalid-option',
              `MCP server "${name}" is not authorized for agent "${ceiling.agent}".`,
            );

          return pinned(server);
        });
      for (const id of task.connections ?? []) {
        const server = [...authorizedMcp.values()].find(
          server => server.connection === id || (!server.connection && server.name === id),
        );
        if (server && !mcp.some(selected => selected.name === server.name))
          mcp.push(pinned(server));
      }

      const asked = path.resolve(String(p.cwd ?? launchCwd));
      // The flow runtime always sends its cwd; only a different directory is an override.
      if (real(asked) !== real(launchCwd) && mcp.some(server => server.command))
        throw new CoderError(
          'invalid-option',
          'Inherited stdio MCP servers do not allow a cwd override.',
        );

      const requested = [asked, ...(p.addDirs ?? []).map((d: string) => path.resolve(asked, d))];
      const missing = requested.find(target => !real(target));
      if (missing)
        throw new CoderError(
          'invalid-option',
          `task "${name}" asks for ${missing}, which does not exist`,
        );

      const [taskCwd, ...addDirs] = requested.map(target => real(target)!) as [string, ...string[]];
      const outside = [taskCwd, ...addDirs].find(target => !inside(target));
      if (outside)
        throw new CoderError(
          'invalid-option',
          `task "${name}" asks for ${outside}, outside the workspace of agent "${ceiling.agent}"`,
        );
      const dispatched = await dispatchTask(
        {
          prompt: String(p.prompt ?? ''),
          outputSchema: p.outputSchema,
          cwd: taskCwd,
          engine: p.engine,
          model: p.model,
          effort: p.effort,
          mcp,
          connections: task.connections,
          connectionSource,
          permissions: capPermissions(name, p.permissions, ceiling),
          name: p.name,
          system: p.system,
          addDirs,
          flowRunId: p.flowRunId,
          wait: true,
        },
        { fromMailbox: true },
      );
      started.set(dispatched.taskId, taskCwd);
      return { taskId: dispatched.taskId };
    },

    async steer(p) {
      const taskCwd = started.get(p.taskId);
      if (!taskCwd)
        throw new CoderError('invalid-option', `No task "${p.taskId}" started by this flow.`);
      const current = loadTaskRecord(taskCwd, p.taskId);
      if (!current) throw new CoderError('invalid-option', `No task "${p.taskId}".`);
      return steerTask(taskCwd, current, String(p.text ?? ''), {
        ...(connectionSource === 'server'
          ? { resolveConnections: heldConnections(task.mcp, launchCwd, pinned) }
          : {}),
        model: p.model,
        effort: p.effort,
        permissions: p.permissions
          ? capPermissions(current.name, p.permissions, ceiling)
          : undefined,
      });
    },

    async wait(p) {
      const taskCwd = started.get(p.taskId);
      if (!taskCwd)
        throw new CoderError('invalid-option', `No task "${p.taskId}" started by this flow.`);
      const waited = await waitTask(taskCwd, p.taskId);
      return {
        status: waited.status,
        result: waited.result,
        model: waited.task.model ?? null,
        next: turnFallbackEngine(taskCwd, waited) ?? null,
      };
    },

    review(p) {
      if (p.op === 'resolveTarget') {
        // The repository comes from the task record; without one only a number in the checkout resolves.
        const { repo: _asked, ...input } = p.input ?? {};
        if (!task.repo && !/^\d+$/.test(String(input.pr)))
          throw new CoderError(
            'invalid-option',
            "review target must be a pull request number in this task's repository",
          );

        const target = resolveReviewTarget(
          {
            ...input,
            cwd,
            ...(task.repo ? { repo: task.repo } : {}),
            ...(task.author ? { author: task.author } : {}),
          },
          auth(),
        );
        if (target.pr) pulls.add(`${target.pr.repo}#${target.pr.number}`);
        return target;
      }
      if (p.op !== 'post')
        throw new CoderError('invalid-option', `unknown review action "${p.op}"`);
      // Only a pull request this task resolved from its own checkout.
      if (!pulls.has(`${p.input?.repo}#${p.input?.pr}`))
        throw new CoderError(
          'invalid-option',
          'review post: pull request was not resolved by this task',
        );
      return postReview({ ...p.input, cwd }, auth());
    },
  });
}
