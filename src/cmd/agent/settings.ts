/** `coder agent settings`: an agent's model, access, runner, connections, skills, events or appended instructions on a server. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { credentialServerOptions, modelOption, str } from '../../utils/args';
import { command } from '../../cli';
import { list, parseMatches } from './init';
import type { SkillSource } from '../../agent/types';
import { COMMIT_SHA } from '../../core/types';

/** `owner/name/path@ref` as a skill source; a 40-character hex `@` is its commit. */
function skillSource(value: string): SkillSource {
  const [location = '', at] = value.split('@');
  const [owner, name, ...rest] = location.split('/');
  const path = rest.join('/');

  return {
    repo: `${owner}/${name}`,
    ...(path ? { path } : {}),
    ...(at ? (COMMIT_SHA.test(at) ? { sha: at } : { ref: at }) : {}),
  };
}

export const commandAgentSettings = command({
  name: 'settings',
  description: "change an agent's settings on your Coder server",
  usage: `Set the model, access, runner, connections, skills, events or appended instructions of an\nagent in the saved workspace, or publish its next version with new instructions or matches.\nSettings you leave out stay as they are.`,
  access: 'write',
  approvalPolicy: 'ask',
  args: {
    id: str('the agent'),
    model: modelOption(),
    access: str('read-only or auto, at most its definition', '<read-only|auto>'),
    runner: str('the runner its tasks start on, by id or name; empty clears it', '<id|name>'),
    connections: str('the connections its tasks may use, by id', '<a,b>'),
    skills: str(
      'repositories whose skills its tasks get, as owner/name[/path][@ref or commit]; empty clears them',
      '<a,b>',
    ),
    events: str('the events it answers on a platform', '<platform=a,b>'),
    instructions: str('its system prompt, published as its next version', '<text>'),
    'append-system': str(
      'text every task reads after its instructions, up to 64 KB; empty clears it',
      '<text>',
    ),
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
  run: async ({
    options: { connections, skills, events, match, 'append-system': appendSystem, ...options },
    args: [id],
  }) => {
    const { agents } = await import('../../agent');
    const [platform, names] = events?.split('=') ?? [];
    return agents.settings(id, {
      ...options,
      appendSystem,
      ...(connections === undefined ? {} : { connections: list(connections) }),
      ...(skills === undefined ? {} : { skills: list(skills).map(skillSource) }),
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
