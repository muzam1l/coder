import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

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
} from '../core/dispatch';
import type { McpServerSpec, Task } from '../core/types';
import type { Integration } from '../integrations/types';
import { effectiveSettings, resolveTools } from './definition';
import { loadAgents } from './load';
import { postReview, resolveReviewTarget, REVIEW_PLATFORM } from '../flow/builtin/review';
import { INTEGRATIONS } from '../integrations';
import { taskToolServers, tokenEnvName, toolServerToken, noteToolServer } from './mcp';
import type { Agent, AgentEvent, AgentTask, TaskContext, TaskSource } from './types';
import { serveMailbox, agentMailboxDir } from '../core/mailbox';

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

/** Post into the event's Chat SDK thread through its integration's adapter, on the task's own token. */
export async function postReply(
  integration: Integration,
  event: AgentEvent,
  text: string,
  token: string,
  author = integration.id,
): Promise<void> {
  if (!event.chat) throw new Error(`The ${event.integration} event has no thread to reply in`);
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
  });
  const chat = new Chat({
    userName: author,
    adapters: { [integration.id]: adapter },
    state: new LocalChatState(),
    logger: 'error',
  });
  await chat.initialize();
  const thread = chat.thread(event.chat.thread.id);
  if (adapter.reply && event.chat.message?.id) await thread.reply(event.chat.message.id, text);
  else await thread.post(text);
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
  note?: string;
  posted?: boolean;
  taskId?: string;
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
  onTask?: (taskId: string) => void | Promise<void>;
  onStart?: import('../flow/runtime').FlowHooks['onStart'];
  /** Secrets passed only to task-core MCP children, never inherited by the engine. */
  toolEnvironment?: { tokens: Record<string, string> };
  postToken?: string;
  noteFile?: string;
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
  if (!agent && task) {
    agent = {
      id: task.agent,
      name: task.definition.name ?? task.agent,
      definition: task.definition,
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

  if (flow === 'default') {
    const defaults = defaultTask(agent, task);
    const noteDir = options.noteFile
      ? undefined
      : await fs.mkdtemp(path.join(os.tmpdir(), 'coder-note-'));
    const noteFile = options.noteFile ?? path.join(noteDir!, 'note');
    if (!options.noteFile) await fs.writeFile(noteFile, task.context?.note ?? '');
    const resolved = resolveTaskOptions(effectiveSettings(agent), config);
    const selectedMcp = selectMcpServers(task.mcp?.join(','), config.mcp, agent.definition.mcp);
    const mcp = [
      ...taskToolServers(task, options.toolEnvironment?.tokens ?? localTokens(task, process.env)),
      noteToolServer(noteFile),
      ...selectedMcp.mcp,
    ];
    const dispatched = options.resumeTaskId
      ? { taskId: options.resumeTaskId }
      : await dispatchTask({
          taskId: options.taskId,
          mcp,
          nativeMcp: selectedMcp.nativeMcp,
          cwd,
          agentId: task.agent,
          ...(task.author ? { author: task.author } : {}),
          ...(event?.repo ? { repo: `${event.repo.owner}/${event.repo.name}` } : {}),
          ...(options.source
            ? { source: options.source }
            : { name: `${AGENT_TASK_PREFIX}${task.id}` }),
          engine: resolved.engine,
          model: resolved.model ?? undefined,
          effort: resolved.effort ?? undefined,
          permissions: task.permissions ?? resolved.permissions,
          system: defaults.system,
          prompt: defaults.prompt,
          outputSchema: task.context?.outputSchema,
          wait: true,
        });
    await options.onTask?.(dispatched.taskId);
    const completed = await waitForAgentTask(cwd, dispatched.taskId, options.onApproval);
    const reply = (completed.result?.finalMessage ?? completed.result?.error?.message ?? '').trim();
    const note = (await fs.readFile(noteFile, 'utf8').catch(() => '')).trim();
    if (noteDir) await fs.rm(noteDir, { recursive: true, force: true });
    const posted = options.post !== false && Boolean(integration);
    if (posted)
      await postReply(
        integration!,
        event!,
        reply,
        options.postToken ?? process.env.APP_TOKEN!,
        task.author,
      );
    return {
      ok: completed.status === 'completed',
      flow,
      reply,
      posted,
      taskId: dispatched.taskId,
      tokens: completed.result?.tokens ?? undefined,
      ...(note !== (task.context?.note ?? '').trim() ? { note } : {}),
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
    },
    {
      ...(options.onTask
        ? { onTaskStart: (started: { taskId: string }) => options.onTask!(started.taskId) }
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
  pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 100)),
) {
  let reportedId: string | undefined;
  for (;;) {
    try {
      return await wait(cwd, taskId);
    } catch (error) {
      if (!(error instanceof CoderError) || error.code !== 'approval-pending' || !onApproval)
        throw error;
      if (error.approval?.id !== reportedId) {
        reportedId = error.approval?.id;
        await onApproval(error.approval);
      }
      await pause();
    }
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
): Promise<{
  engine?: string;
  model?: string;
  effort?: string;
  permissions?: string;
  system?: string;
  mcp: McpServerSpec[];
  nativeMcp: boolean;
}> {
  const agents = await loadAgents(cwd, INTEGRATIONS);
  const agent = agents.find(a => a.id === id);
  if (!agent)
    throw new CoderError('invalid-option', `No agent named "${id}".`, {
      hint: `Agents here: ${agents.map(a => a.id).join(', ')}`,
    });
  const { definition, usage } = agent;

  const own = definition.mcp ?? {};
  const mcp = selectMcpServers(mcpFlag, loadConfig(cwd).mcp, own);

  return {
    engine: usage?.engine ?? definition.engine,
    model: usage?.model ?? definition.model,
    effort: usage?.effort ?? definition.effort,
    permissions: usage?.permissions ?? definition.permissions,
    system: agentInstructions(agent) || undefined,
    ...mcp,
  };
}

const MAX_SYSTEM_CHARS = 48_000;

/** Core prompt every default agent runs with; the agent folder's markdown is appended, never replaces it. */
const CORE_AGENT_PROMPT = `You are an agent named "{name}" acting on behalf of a software team. You receive one request, a platform event or a task, and must produce the reply that goes back to its thread verbatim. Be direct and specific, use the attached tools to read context before answering, never invent facts about the repository, and stay within the actions your tools allow. Reply in plain markdown with no preamble.`;

export function agentSystemPrompt(agent: Agent): string {
  const core = CORE_AGENT_PROMPT.replace('{name}', agent.definition.name ?? agent.id);
  const parts = [core];
  if (agent.definition.description) parts.push(`Your role: ${agent.definition.description}`);
  const extra = agentInstructions(agent);
  if (extra) parts.push(`## Agent instructions\n\n${extra}`);
  return parts.join('\n\n');
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

function renderEvent(event: AgentEvent): string {
  const lines = [
    `**Integration:** ${event.integration}`,
    `**Type:** ${event.type}`,
    `**Actor:** ${event.actor.login ?? event.actor.id}`,
  ];
  if (event.repo) lines.push(`**Repo:** ${event.repo.owner}/${event.repo.name}`);
  if (event.chat)
    lines.push(
      `**Thread:** ${event.chat.thread.id}${event.chat.thread.isDM ? ' (direct message)' : ''}`,
    );
  return [lines.join('\n'), event.promptContext, event.text].filter(Boolean).join('\n\n');
}

/** Thread history, note and repo instructions as prompt sections, in that order. */
export function renderContext(context: TaskContext | undefined): string {
  if (!context) return '';
  const sections: string[] = [];
  if (context.messages?.length)
    sections.push(
      `## Recent thread\n\n${context.messages.map(m => `- ${m.user}: ${m.text}`).join('\n')}`,
    );
  if (context.note) sections.push(`## Note from earlier in this thread\n\n${context.note}`);
  if (context.instructions) sections.push(`## Repository instructions\n\n${context.instructions}`);
  if (context.user)
    sections.push(
      `## Who asked\n\n${context.user.name} (${context.user.email}), a member of this Coder server.`,
    );
  return sections.join('\n\n');
}

function renderRequest({ event, prompt }: Pick<AgentTask, 'event' | 'prompt'>): string {
  if (prompt === undefined) return event ? renderEvent(event) : '';
  return event?.repo ? `**Repo:** ${event.repo.owner}/${event.repo.name}\n\n${prompt}` : prompt;
}

export function defaultTask(
  agent: Agent,
  task: Pick<AgentTask, 'event' | 'prompt' | 'context'>,
): { system: string; prompt: string } {
  const extra = renderContext(task.context);
  const hint =
    task.prompt === undefined && task.event
      ? INTEGRATIONS[task.event.integration]?.hint
      : undefined;
  const request = renderRequest(task);
  return {
    system: [agentSystemPrompt(agent), hint ? `## Platform\n\n${hint}` : '']
      .filter(Boolean)
      .join('\n\n'),
    prompt: extra ? `${request}\n\n${extra}` : request,
  };
}

export function startAgentMailbox(cwd: string, task: Task): () => void {
  const dir = agentMailboxDir(cwd, task);
  if (!dir) return () => {};
  const ceiling = { agent: task.agentId!, permissions: task.permissions ?? 'auto' };
  const launchCwd = realpathSync(cwd);
  const authorizedMcp = new Map((task.mcp ?? []).map(server => [server.name, server] as const));
  // Pinned to the parent's launch directory when a request picks it, so a mailbox cwd cannot swap it.
  const pinned = (server: McpServerSpec) => {
    if (!server.command) return server;
    const [resolved] = resolveMcpServers([server], process.env, launchCwd);

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
      if (p.resume && !started.has(p.resume))
        throw new CoderError(
          'invalid-option',
          `task "${name}" resumes a task this flow did not start`,
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
          permissions: capPermissions(name, p.permissions, ceiling),
          name: p.name,
          system: p.system,
          resume: p.resume,
          addDirs,
          flowRunId: p.flowRunId,
          wait: true,
        },
        { fromMailbox: true },
      );
      started.set(dispatched.taskId, taskCwd);
      return { taskId: dispatched.taskId };
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
