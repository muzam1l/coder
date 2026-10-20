/** The tools Coder serves a task: review, escalate, the conversation tools in a conversation, and the tool search on Codex turns. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { defineApp, defineCommand } from 'contextjsx';
import * as z from 'zod/mini';

import { arg, str, strList } from '../../../utils/args';
import { conversationCommands } from '../../../agent/context/tools';
import { renderReviewMarkdown, type ReviewResult } from '../../../flow/builtin/review';
import { escalate } from '../../approvals';
import { mcpClient, type McpClient, type McpToolInfo } from '../../connections';
import type { McpServerSpec } from '../../types';
import { startAsyncTool, type AsyncTool } from '../async';

interface ReviewInput {
  pr?: number;
  base?: string;
  path?: string[];
  exclude?: string[];
}

const review: AsyncTool<ReviewInput> = {
  name: 'review',
  flow: 'review',
  limit: 5,
  args: (input, cwd) => ({
    // A pull request's review compares its own base and posts on it.
    ...(input.pr !== undefined ? { pr: input.pr, post: true } : { base: input.base ?? 'HEAD' }),
    ...(input.path?.length ? { path: input.path } : {}),
    ...(input.exclude?.length ? { exclude: input.exclude } : {}),
    cwd,
  }),
  render: (result, runId) => renderReviewMarkdown({ ...(result as ReviewResult), runId }),
};

/** Tools that return at once; their result arrives later as a message. */
export const asyncTools: AsyncTool[] = [review];

/** Every tool whose answer arrives later as a message. */
export const ASYNC_TOOL_NAMES = [...asyncTools.map(tool => tool.name), 'escalate'];

/** The task's record, which the tools act for. */
function taskDir(): string {
  const file = process.env.CODER_HISTORY_TASK;
  if (!file) throw new Error('CODER_HISTORY_TASK is not set');

  return path.dirname(file);
}

export const taskApp = defineApp({
  name: 'coder',
  description: "This task's own tools.",
  commands: [
    defineCommand({
      name: 'escalate',
      description:
        "Ask a human to approve actions your environment refused, all in one request, collect all actions needed at once so you don't spam the user.",
      args: {
        reason: str('One short sentence: what the actions are for.'),
        actions: strList(
          'Each action is exactly the command you will run once approved, nothing added; notes go in reason.',
        ),
      },
      access: 'read',
      run: ({ reason, actions }) => {
        const exact = (actions ?? []).map(action => action.trim()).filter(Boolean);
        if (!reason?.trim() || !exact.length) throw new Error('reason and actions are required');
        const dir = taskDir();
        const approval = escalate(process.cwd(), path.basename(dir), dir, {
          reason: reason.trim(),
          actions: exact,
        });

        return { approvalId: approval.id, status: 'pending' };
      },
    }),
    defineCommand({
      name: 'review',
      description: `Review your changes with a separate read-only reviewer that checks each finding against the repository. One review at a time, ${review.limit} per task.`,
      args: {
        pr: arg(z.optional(z.number()), 'A pull request to review and post the review on.'),
        base: str('The ref to compare with; default HEAD, so only uncommitted changes.'),
        path: strList('Review only these paths, relative to the task directory.'),
        exclude: strList('Leave these paths out.'),
        timeout: arg(z.optional(z.number()), 'Stop the review after this many seconds.'),
      },
      access: 'read',
      run: async ({ timeout, ...input }) => ({
        runId: await startAsyncTool(taskDir(), review, input, timeout),
        status: 'started',
      }),
    }),
    ...conversationCommands,
  ],
});

/** The 0600 file with the turn's resolved servers, written by the worker. */
export const TOOL_SEARCH_ENV = 'CODER_TOOL_SEARCH';

export const SEARCH_TOOLS = ['find_tools', 'call_tool'];

/** Matches past this many get names only, so one answer stays small. */
const SCHEMA_LIMIT = 5;

interface Connected {
  spec: McpServerSpec;
  client: McpClient;
  /** Only what the turn may call: the spec's tool list, and only `readOnlyHint` tools on a read-only server. */
  tools: McpToolInfo[];
}

/** Connects to a server within `startupMs` and lists the tools its spec allows; the connection then lives for the turn. */
export async function connect(spec: McpServerSpec, startupMs = 60_000): Promise<Connected> {
  const startup = AbortSignal.timeout(startupMs);
  const late = (error: unknown) =>
    startup.aborted ? new Error(`MCP server ${spec.name} did not start in time`) : error;
  const client = await mcpClient(spec, fetch, startup).catch(error => {
    throw late(error);
  });
  try {
    const tools = (await client.tools()).filter(
      tool =>
        (!spec.tools?.length || spec.tools.includes(tool.name)) &&
        (!spec.readOnly || tool.annotations?.readOnlyHint === true),
    );

    return { spec, client, tools };
  } catch (error) {
    await client.close().catch(() => {});
    throw late(error);
  }
}

/** Matching tools: an exact name alone, else every term of `query` in the name or description, name matches first. */
export function matching(tools: McpToolInfo[], query: string | undefined): McpToolInfo[] {
  const exact = tools.find(tool => tool.name === query?.trim());
  if (exact) return [exact];
  const terms = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const has = (text: string) => terms.every(term => text.toLowerCase().includes(term));
  const found = tools.filter(tool => has(`${tool.name} ${tool.description ?? ''}`));

  return [...found.filter(tool => has(tool.name)), ...found.filter(tool => !has(tool.name))];
}

/** The search's two tools over the turn's servers, each connected on its first use. */
export function searchApp(
  servers: McpServerSpec[],
  open: (spec: McpServerSpec) => Promise<Connected> = connect,
) {
  const specs = new Map(servers.map(spec => [spec.name, spec]));
  const connections = new Map<string, Promise<Connected>>();
  const server = (name: string) => {
    const spec = specs.get(name);
    if (!spec)
      throw new Error(
        `Unknown server "${name}". Servers: ${[...specs.keys()].join(', ') || 'none'}`,
      );
    let connected = connections.get(spec.name);
    if (!connected) {
      connected = open(spec).catch(error => {
        connections.delete(spec.name);
        throw error;
      });
      connections.set(spec.name, connected);
    }

    return connected;
  };
  const serverArg = arg(z.string(), 'A server name from the prompt.');

  return defineApp({
    name: 'tools',
    description: "The turn's MCP servers, searched on demand.",
    commands: [
      defineCommand({
        name: 'find_tools',
        description:
          'Find tools on one of the servers listed in your prompt by words from their names or descriptions; an empty query lists them all. Returns up to 5 matches with name, one line and input schema, then the names of the rest; query a tool by its exact name to get its schema.',
        args: {
          server: serverArg,
          query: str('Words that the tool name or description contain, such as "issue list".'),
        },
        access: 'read',
        run: async args => {
          const { spec, tools } = await server(args.server);
          const found = matching(tools, args.query);
          const names = (list: McpToolInfo[]) => list.map(tool => tool.name).join(', ') || 'none';
          if (!found.length) return `No tool on ${spec.name} matches. Its tools: ${names(tools)}`;
          const rest = found.slice(SCHEMA_LIMIT);

          return {
            tools: found.slice(0, SCHEMA_LIMIT).map(tool => ({
              name: tool.name,
              description: (tool.description ?? '').split('\n')[0]!.trim(),
              inputSchema: tool.inputSchema ?? { type: 'object' },
            })),
            ...(rest.length ? { more: names(rest) } : {}),
          };
        },
      }),
      defineCommand({
        name: 'call_tool',
        description: "Call a tool found with find_tools. Returns the server's result as is.",
        args: {
          server: serverArg,
          tool: arg(z.string(), 'A tool name find_tools returned.'),
          args: arg(
            z.optional(z.record(z.string(), z.unknown())),
            "The tool's arguments, matching its input schema.",
          ),
        },
        access: 'write',
        run: async args => {
          const { spec, client, tools } = await server(args.server);
          if (!tools.some(tool => tool.name === args.tool))
            throw new Error(
              spec.readOnly
                ? `This task is read-only; "${args.tool}" is not a read-only tool on ${spec.name}.`
                : `No tool "${args.tool}" on ${spec.name}; find it with find_tools first`,
            );

          return (await client.call(args.tool, args.args ?? {})) ?? null;
        },
      }),
    ],
  });
}

/** The turn's servers from the file the worker wrote. */
export function searchServers(file: string | undefined): McpServerSpec[] {
  if (!file) throw new Error(`${TOOL_SEARCH_ENV} is not set`);

  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
