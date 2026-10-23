/** @jsxImportSource contextjsx */
/** The tool search's app: its instructions, rendered once per turn, and its two tools, which the runtime (`index.ts`) answers. */
import { defineApp, defineCommand, render } from 'contextjsx';
import * as z from 'zod/mini';

import type { McpServerSpec } from '../types';
import { arg, str } from '../../utils/args';

/** A turn's server; a `start` one connected at turn start has its instructions and tool names. */
export type ListedServer = McpServerSpec & {
  started?: { instructions?: string; tools: string[] };
};

export interface FindArgs {
  server: string;
  query?: string;
}

export interface CallArgs {
  server: string;
  tool: string;
  args?: Record<string, unknown>;
}

/** What answers each tool. */
export interface SearchHandlers {
  find: (args: FindArgs) => Promise<unknown>;
  call: (args: CallArgs) => Promise<unknown>;
}

/** Tool names grouped by namespace, like contextjsx's own index: `task: run list`. */
const grouped = (tools: string[]) => {
  const groups = new Map<string, string[]>();
  for (const tool of tools) {
    const at = tool.lastIndexOf('/');
    const key = at < 0 ? '' : tool.slice(0, at);
    groups.set(key, [...(groups.get(key) ?? []), tool.slice(at + 1)]);
  }

  return [...groups].flatMap(([key, names]) =>
    key ? [`- "${key}": ${names.join(' ')}`] : names.map(name => `- "${name}"`),
  );
};

/** A connection's scope (system prompt `<scopes>`): a member's own acts as them, an app's installation or a shared server as the workspace. */
export const serverScope = ({ owner, integration, connection }: McpServerSpec) =>
  owner ? 'personal' : integration || connection ? 'workspace' : undefined;

const SearchInstructions = ({ servers }: { servers: ListedServer[] }) => (
  <>
    {[
      'find_tools and call_tool reach these MCP servers:',
      ...servers.map(server => {
        const scope = serverScope(server);
        const about =
          server.description ??
          (server.url && URL.canParse(server.url) ? new URL(server.url).host : server.command);

        return `- "${server.name}"${scope ? ` (${scope})` : ''}${about ? `: ${about}` : ''}`;
      }),
    ].join('\n')}
    {servers.map(
      ({ name, started }) =>
        started && (
          <>
            <instructions server={name}>{started.instructions}</instructions>
            <tools server={name}>
              {['Each name is namespace/tool, such as task/run.', ...grouped(started.tools)].join(
                '\n',
              )}
            </tools>
          </>
        ),
    )}
  </>
);

export const searchInstructions = (servers: ListedServer[]) =>
  render(<SearchInstructions servers={servers} />);

const serverArg = arg(z.string(), "A server name from the tool search's instructions.");

export const toolSearchApp = ({ find, call }: SearchHandlers, instructions?: string) =>
  defineApp({
    name: 'tools',
    description: "The turn's MCP servers, searched on demand.",
    ...(instructions ? { instructions } : {}),
    commands: [
      defineCommand({
        name: 'find_tools',
        description: [
          "Find tools on a server listed in the tool search's instructions.",
          'With only the server: its status, instructions and every tool name.',
          'With a query: up to 5 tools whose name or description contains every word, each with its input schema, then the names of the rest.',
          'An exact tool name returns its schema.',
          'A needs-auth status comes with a reconnect link: give it to the person and go on with what you can.',
        ].join(' '),
        args: {
          server: serverArg,
          query: str('Words in the tool name or description, such as "issue list".'),
        },
        access: 'read',
        run: find,
      }),
      defineCommand({
        name: 'call_tool',
        description: [
          'Call a tool found with find_tools, with arguments matching its input schema.',
          "Returns the server's result as is.",
        ].join(' '),
        args: {
          server: serverArg,
          tool: arg(z.string(), 'A tool name find_tools returned.'),
          args: arg(
            z.optional(z.record(z.string(), z.unknown())),
            "The tool's arguments, matching its input schema.",
          ),
        },
        access: 'write',
        run: call,
      }),
    ],
  });
