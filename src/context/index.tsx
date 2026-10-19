/** @jsxImportSource contextjsx */

/** Model-facing commands and guides, sharing the CLI arguments and finite command handlers. */
import { defineApp, type Command, type Namespace } from 'contextjsx';

import { cli } from '../cmd';
import { GUIDES, SKILLS } from './skills';

function commandForMcp(command: Command, at: string[]): Command {
  const id = [...at, command.name].join('/');
  const mapped: Command = {
    ...command,
    ...(command.name === 'watch' || ['docs', 'auth/login', 'setup-host', 'upgrade'].includes(id)
      ? { mcp: false as const }
      : {}),
  };

  return mapped;
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
