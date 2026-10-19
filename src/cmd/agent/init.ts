/** `coder agent init <id>`: scaffold `.coder/agents/<id>/` from the integration catalog. */
import path from 'node:path';
import process from 'node:process';

import type { AgentPicks } from '../../agent';
import type { AgentDefinition, Preset } from '../../agent/types';
import { outStyle } from '../../tui/output';
import { ask, canPrompt, pick, pickDetailed } from '../../tui/prompt';
import { flag, str } from '../../utils/args';
import { command, nextSteps } from '../../cli';

const PRESET_LABELS: Record<Preset, string> = {
  read: 'Read-only',
  write: 'Read-write',
};

/** What it made and the next steps. */
function printAgentInit(
  result: { id: string; samples: string[]; integrations: string[] },
  rel: string,
): void {
  const s = outStyle;
  process.stdout.write(`Created ${s.cyan(rel)}.\n`);
}

function agentInitNext(
  result: { id: string; samples: string[]; integrations: string[]; dir: string },
  cwd: string,
) {
  const { id, samples, integrations: ids } = result;
  const rel = path.relative(cwd, result.dir);
  const steps = nextSteps(
    ids.length
      ? [
          `1. Write ${rel}/system.md. Try it with no server: coder task run --agent ${id} "<task>"`,
          `2. Run it on a server: coder dash on this machine reads it from this repo; a cloud server imports it from the dashboard or with coder agent push.`,
          `3. On the dashboard, create the agent's app on each platform it uses (${ids.join(', ')}) from its Platforms tab, and install it.`,
          `4. Fire an event by hand, or leave --server out to run it offline: coder agent run ${id} ${samples[0] ?? '<event.json>'} --server <url>`,
          'Guide: https://github.com/muzam1l/coder/blob/main/docs/agents/index.md',
          'Agents: coder docs agents',
        ]
      : [
          `1. Write ${rel}/system.md. Try it with no server: coder task run --agent ${id} "<task>"`,
          `2. Give the agent a platform under "integrations" in ${rel}/agent.json, then run init again or follow the guide: coder agent integrations list`,
          'Guide: https://github.com/muzam1l/coder/blob/main/docs/agents/index.md',
          'Agents: coder docs agents',
        ],
  );
  if (ids.length) steps[1]!.usage = 'coder dash';
  return steps;
}

/** Interactive picks when nothing was passed and a person is on the other end. */
async function askPicks(id: string): Promise<AgentPicks> {
  const { regexError } = await import('../../agent');
  const { INTEGRATIONS } = await import('../../integrations');
  const { PRESETS } = await import('../../agent/types');

  const s = outStyle;
  process.stdout.write(
    `Creating ${s.cyan(`.coder/agents/${id}`)}. Pick what the agent listens to and what it may do; flags skip these questions.\n\n`,
  );
  const integrations = await pick({
    title: 'Integrations',
    hint: 'Platforms the agent listens to and acts on. Add or remove them later in agent.json.',
    multi: true,
    selected: [Object.keys(INTEGRATIONS)[0]!],
    options: Object.values(INTEGRATIONS).map(i => ({ value: i.id, hint: i.description })),
  });
  const events: Record<string, string[]> = {};
  const matches: Record<string, Record<string, string>> = {};
  for (const integrationId of integrations) {
    const catalog = INTEGRATIONS[integrationId]!;
    const names = Object.keys(catalog.events);
    const picked = await pickDetailed({
      title: `${integrationId} events`,
      hint: `What wakes the agent on ${integrationId}; each event runs the agent with that event as its prompt.`,
      multi: true,
      required: true,
      selected: names.filter(name => !catalog.events[name]!.noisy),
      options: Object.entries(catalog.events).map(([value, spec]) => ({
        value,
        hint: spec.description,
        ...(spec.noisy
          ? {
              input: {
                label: 'match',
                value: '^help\\b',
                placeholder: 'tab to add a match',
                validate: regexError,
              },
            }
          : {}),
      })),
    });
    events[integrationId] = picked.values;
    matches[integrationId] = picked.inputs as Record<string, string>;
  }
  const [access] = await pick<Preset>({
    title: 'Access',
    hint: 'What the agent may do on its platforms and connections; Read-write allows every tool.',
    selected: ['write'],
    options: PRESETS.map(value => ({ value, label: PRESET_LABELS[value] })),
  });
  const name = await ask('Display name', id, undefined, 'Shown in replies and app names.');
  return { ...(name !== id ? { name } : {}), integrations, events, matches, access: access! };
}

export const commandAgentInit = command({
  name: 'init',
  description: 'scaffold an agent folder in .coder/agents',
  usage:
    'Create .coder/agents/<id>/ with an agent.json built from the integration catalog, a system.md to write the prompt in, and one sample event per integration for `coder agent run`. Asks for the id, integrations, events, and access when run in a terminal without them.',
  access: 'write',
  args: {
    id: str('the agent id: its folder under .coder/agents'),
    integrations: str(
      'platforms the agent listens to (see coder agent integrations list)',
      '<a,b>',
    ),
    events: str(
      'events that start tasks, applied to each integration that has them (default: mention)',
      '<a,b>',
    ),
    access: str('read or write, on its platforms and connections (default: write)', '<mode>'),
    name: str('display name used in replies (default: the id)', '<text>'),
    description: str('one line for agent list', '<text>'),
    permissions: str('engine permission mode (default: auto)', '<mode>'),
    match: str(
      'start tasks only for event text matching a regex, as event=regex pairs',
      '<a=re,b=re>',
    ),
    yes: flag('skip the questions and take the defaults'),
  },
  cli: {
    positional: ['id'],
    examples: [
      'coder agent init  # answer the questions, id included',
      'coder agent init triage --integrations github --events issue,mention --access read  # no questions',
    ],
  },
  run: async ({ options, args: [id], cwd, tool }) => {
    const { agents } = await import('../../agent');

    const interactive = !tool && canPrompt() && !options.yes;
    return agents.init(id, {
      ...options,
      cwd,
      permissions: options.permissions as AgentDefinition['permissions'],
      ...(interactive
        ? {
            askId: validate =>
              ask(
                'Agent id',
                '',
                validate,
                'Folder name under .coder/agents and the name used in commands.',
              ),
          }
        : {}),
      ...(interactive && !options.integrations ? { askPicks } : {}),
    });
  },
  json: (result, { cwd }) => ({
    id: result.id,
    dir: path.relative(cwd, result.dir),
    files: result.files,
    samples: result.samples,
  }),
  next: ({ result, args }) =>
    agentInitNext(result, args.cwd ? path.resolve(args.cwd) : process.cwd()),
  print: (result, { cwd }) => printAgentInit(result, path.relative(cwd, result.dir)),
});
