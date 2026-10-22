/** `coder agent settings`: an agent's engine, model or effort on a server. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { credentialServerOptions, str } from '../../utils/args';
import { command } from '../../cli';
import { list, parseMatches } from './init';

export const commandAgentSettings = command({
  name: 'settings',
  description: "change an agent's settings on your Coder server",
  usage: `Set the model, effort, access, connections or events of an agent in the\nsaved workspace, or publish its next version with new instructions or matches.\nSettings you leave out stay as they are.`,
  access: 'write',
  approvalPolicy: 'ask',
  args: {
    id: str('the agent'),
    model: str('model alias, custom name or engine:model', '<model|engine:model>'),
    effort: str('low, medium or high', '<level>'),
    access: str('read-only or auto, at most its definition', '<read-only|auto>'),
    connections: str('the connections its tasks may use, by id', '<a,b>'),
    events: str('the events it answers on a platform', '<platform=a,b>'),
    instructions: str('its system prompt, published as its next version', '<text>'),
    match: str(
      'start tasks only for event text matching a regex, as event=regex pairs',
      '<a=re,b=re>',
    ),
    ...credentialServerOptions,
  },
  globalFlags: { cwd: false },
  cli: {
    positional: ['id'],
    examples: ['coder agent settings helper --model sonnet  # a cheaper model for a simple agent'],
  },
  run: async ({ options: { connections, events, match, ...options }, args: [id] }) => {
    const { agents } = await import('../../agent');
    const [platform, names] = events?.split('=') ?? [];
    return agents.settings(id, {
      ...options,
      ...(connections === undefined ? {} : { connections: list(connections) }),
      ...(platform && names !== undefined ? { events: { [platform]: list(names) } } : {}),
      matches: parseMatches(match),
    });
  },
  print: record => {
    const { engine, model, effort } = record.settings ?? {};
    process.stdout.write(
      `Agent ${outStyle.cyan(record.id)} runs on ${[engine, model, effort].filter(Boolean).join('/') || 'its defaults'}.\n`,
    );
  },
});
