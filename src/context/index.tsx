/** @jsxImportSource contextjsx */

/** Model-facing commands and guides, sharing the CLI arguments and finite command handlers. */
import { defineApp, type Command, type Namespace, type Shape } from 'contextjsx';
import * as z from 'zod/mini';

import { cli } from '../cmd';
import { GUIDES, SKILLS } from './skills';

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

function commandForMcp(command: Command, at: string[]): Command {
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

function namespaceForMcp(namespace: Namespace, at: string[] = []): Namespace {
  const path = [...at, namespace.name];

  return {
    ...namespace,
    commands: namespace.commands.map(command => commandForMcp(command, path)),
    namespaces: namespace.namespaces?.map(child => namespaceForMcp(child, path)),
  };
}

/** Coder's MCP app: every CLI command as a tool, and the guides. Agent tasks get a narrower view (`agent/context/coder.tsx`). */
export const app = defineApp({
  ...cli,
  instructions: [
    'Coder runs coding agents: subagents on this machine for the work in front of you, and always-on agents in Coder Cloud that work in GitHub, Slack and other apps.',
    'On this machine, task/run starts a subagent on any engine (Claude, Codex or a custom model). task/result returns its answer, task/steer continues it, and task/approve answers its permission requests. flow/run runs a TypeScript flow of many tasks; review reviews a diff.',
    'For Coder Cloud, pass server to the same tools; sign in once with `coder auth login` in a terminal. agent/push publishes an agent, and connection/add gives tasks accounts, keys and MCP servers.',
    'Every result lists its next steps; follow them. load_skill loads a guide.',
  ].join('\n'),
  commands: cli.commands.map(command => commandForMcp(command, [])),
  namespaces: [...cli.namespaces.map(namespace => namespaceForMcp(namespace))],
  skills: [SKILLS.agents, ...GUIDES],
});
