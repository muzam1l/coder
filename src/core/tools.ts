/** Coder's commands as MCP tools: shaped for the local app, or bound to a cloud task's own server by each command's `approvalPolicy`. */
import process from 'node:process';

import type { Command, Namespace, Shape } from 'contextjsx';
import * as z from 'zod/mini';

import { CoderError } from './errors';

/** The page a person finishes the call on, prefilled; `button` is what they click. */
type Handoff = { page: string; action: string; args: string[]; label: string; button?: string };

export type ApprovalPolicy = 'allow' | 'ask' | 'deny' | { handoff: Handoff };

type PolicyCommand = Command & { approvalPolicy?: ApprovalPolicy };

/** CLI flag spellings as MCP argument names: `--wait` is `wait`; an array needs no "(repeatable)". */
const mcpText = (text: string) =>
  text.replace(/\s*\(repeatable\)/g, '').replace(/--([a-z][\w-]*)/g, '$1');

/** A command's arguments over MCP: no `json`, since a tool always returns the JSON payload. */
function mcpArgs(args: Shape = {}): Shape {
  return Object.fromEntries(
    Object.entries(args).flatMap(([name, schema]) => {
      if (name === 'json') return [];
      const meta = z.globalRegistry.get(schema as z.ZodMiniType);
      if (!meta?.description || mcpText(meta.description) === meta.description)
        return [[name, schema]];
      const copy = (schema as z.ZodMiniType).clone();
      z.globalRegistry.add(copy, { ...meta, description: mcpText(meta.description) });

      return [[name, copy]];
    }),
  );
}

export function commandForMcp(command: Command, at: string[]): Command {
  const id = [...at, command.name].join('/');
  if (command.name === 'watch' || ['docs', 'auth/login', 'setup-host', 'upgrade'].includes(id))
    return { ...command, mcp: false };
  if (command.mcp === false) return command;

  return {
    ...command,
    args: mcpArgs(command.args),
    mcp: { ...command.mcp, description: mcpText(command.description) },
  };
}

export function namespaceForMcp(namespace: Namespace, at: string[] = []): Namespace {
  const path = [...at, namespace.name];

  return {
    ...namespace,
    commands: namespace.commands.map(command => commandForMcp(command, path)),
    namespaces: namespace.namespaces?.map(child => namespaceForMcp(child, path)),
  };
}

/** Arguments that pick a server or a folder: the task's own server is the only one. */
const BOUND_ARGS = new Set(['server', 'workspace', 'yes', 'cwd', 'dir']);

/** The dashboard page a command's result belongs to. */
function dashboardPage(id: string, value: unknown, args: Record<string, unknown>): string {
  const [head] = id.split('/');
  const task =
    (value && typeof value === 'object' && (value as { taskId?: unknown }).taskId) ??
    args['task-id'];
  const agent = args.id;
  if (head === 'task')
    return typeof task === 'string' ? `/tasks/${encodeURIComponent(task)}` : '/tasks';
  if (head === 'agent')
    return typeof agent === 'string' ? `/agents/${encodeURIComponent(agent)}` : '/agents';
  if (head === 'credentials') return '/settings/credentials';
  if (head === 'runner') return '/settings/runners';
  if (head === 'model') return '/settings/models';
  return '/settings/connections';
}

/** A command bound to the task's server: no server or folder arguments, its result followed by its dashboard link. */
function boundCommand(command: PolicyCommand, at: string[]): Command {
  const id = [...at, command.name].join('/');
  const shaped = commandForMcp(command, at);
  const args = Object.fromEntries(
    Object.entries(shaped.args ?? {}).filter(([name]) => !BOUND_ARGS.has(name)),
  );
  const text = shaped.mcp && shaped.mcp.text;

  return {
    ...shaped,
    args,
    run: async (given, ctx) => {
      try {
        return {
          ...((await shaped.run({ ...given, server: true }, ctx)) as object),
          args: given,
        };
      } catch (error) {
        // A Confirm write: the server holds it until a person approves.
        if (
          command.approvalPolicy !== 'ask' ||
          !(error instanceof CoderError) ||
          error.code !== 'approval-pending'
        )
          throw error;
        const value = { pending: true, reason: error.message };

        return { value, output: value, args: given };
      }
    },
    next: input =>
      (shaped.next?.(input) ?? []).map(step => ({
        ...step,
        usage: step.usage.replace(/ --server\b/, ''),
      })),
    mcp: {
      ...shaped.mcp,
      text: (result: { value: unknown; output: unknown; args: Record<string, unknown> }) => {
        // One server here, so its flag is noise in the steps a result quotes.
        const pending = result.value as { pending?: boolean; reason?: string };
        const body = pending?.pending
          ? `Asked for approval in the thread. ${pending.reason} Nothing changes until someone allowed to approve it does, in the thread or on the task's page.`
          : (text ? text(result) : (JSON.stringify(result.output) ?? '')).replace(
              / --server\b/g,
              '',
            );
        const dashboard = process.env.CODER_DASHBOARD;
        const page = dashboardPage(id, result.value, result.args);
        const destination = page.startsWith('/tasks/')
          ? 'the task'
          : page.startsWith('/agents/')
            ? 'the agent'
            : page.split('/').at(-1);

        return dashboard ? `${body}\n[Open ${destination}](${dashboard}${page})` : body;
      },
    },
  };
}

/** A handoff's dashboard page, prefilled with `given`. */
export function handoffLink(
  { page, action, args: kept }: Pick<Handoff, 'page' | 'action' | 'args'>,
  given: Record<string, unknown>,
  dashboard = process.env.CODER_DASHBOARD ?? '',
): string {
  const [first, ...rest] = kept;
  const path = page.replace(/:([\w-]+)/g, (_, name: string) =>
    encodeURIComponent(String(given[name] ?? '')),
  );
  const query = new URLSearchParams();
  query.set(action, path === page ? String(given[first!] ?? '') : '1');
  for (const name of rest)
    if (given[name] !== undefined && given[name] !== false) query.set(name, String(given[name]));

  return `${dashboard}${path}?${query}`;
}

/** A write the person finishes on its dashboard page: the result is the page, prefilled, and nothing is sent to the server. */
function linkCommand(command: Command, at: string[], handoff: Handoff): Command {
  const { args: kept, label, button } = handoff;
  const shaped = commandForMcp(command, at);
  const args = Object.fromEntries(
    Object.entries(shaped.args ?? {}).filter(([name]) => kept.includes(name)),
  );
  const link = (given: Record<string, unknown>) => handoffLink(handoff, given);

  return {
    ...shaped,
    access: 'read',
    args,
    run: async given => ({
      value: { link: link(given) },
      output: { link: link(given) },
      args: given,
    }),
    next: () => [],
    mcp: {
      ...shaped.mcp,
      text: (result: { value: unknown }) => {
        const url = (result.value as { link: string }).link;
        return button
          ? `Give the person this link; they check it and click ${button} there. [${label}](${url})`
          : `Give the person this link; they finish there and any key goes straight to Coder, never through you. [${label}](${url})`;
      },
    },
  };
}

/** The commands a cloud task reaches: all but `deny`, a handoff as its page link. */
export function boundCommands(commands: Command[], at: string[]): Command[] {
  return commands.flatMap(command => {
    const { approvalPolicy = 'allow' } = command as PolicyCommand;
    if (approvalPolicy === 'deny') return [];

    return [
      typeof approvalPolicy === 'object'
        ? linkCommand(command, at, approvalPolicy.handoff)
        : boundCommand(command, at),
    ];
  });
}

/** A namespace's commands a cloud task reaches; a namespace with none is left out. */
export function boundNamespace(namespace: Namespace, at: string[] = []): Namespace | undefined {
  const path = [...at, namespace.name];
  const commands = boundCommands(namespace.commands, path);
  const namespaces = (namespace.namespaces ?? [])
    .map(child => boundNamespace(child, path))
    .filter((child): child is Namespace => Boolean(child));
  if (!commands.length && !namespaces.length) return undefined;

  return { ...namespace, commands, namespaces };
}
