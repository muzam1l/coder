/** `coder agent init <id>`: scaffold `.coder/agents/<id>/` from the integration catalog. */
import path from 'node:path';
import process from 'node:process';

import type { AgentPicks } from '../../agent';
import type { AgentDefinition, Preset } from '../../agent/types';
import { formatHints, outStyle } from '../../tui/output';
import { ask, canPrompt, pick, pickDetailed } from '../../tui/prompt';
import { baseOptions, flag, str } from '../../utils/args';
import { command } from '../../cli';

const PRESET_HINTS: Record<Preset, string> = {
  observe: 'read the platform only',
  comment: 'also post replies and reactions',
  write: 'also push, branch, and open or merge pull requests',
};

/** What it made and the next steps. */
function printAgentInit(
  result: { id: string; samples: string[]; integrations: string[] },
  rel: string,
): void {
  const s = outStyle;
  const { id, samples, integrations: ids } = result;
  process.stdout.write(`Created ${s.cyan(rel)}.\n`);
  const steps = ids.length
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
      ];
  process.stdout.write(`\n${formatHints(steps, s)}\n`);
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
      selected: [names.includes('mention') ? 'mention' : names[0]!],
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
  const [tools] = integrations.length
    ? await pick<Preset>({
        title: 'Tools',
        hint: 'What the agent may do on its platforms; comment suits most agents.',
        selected: ['comment'],
        options: PRESETS.map(value => ({ value, hint: PRESET_HINTS[value] })),
      })
    : ['comment' as Preset];
  const name = await ask('Display name', id, undefined, 'Shown in replies and app names.');
  return { ...(name !== id ? { name } : {}), integrations, events, matches, tools: tools! };
}

export const commandAgentInit = command({
  name: 'agent init',
  help: {
    usage:
      'coder agent init [id] [--integrations a,b] [--triggers a,b] [--tools <preset>] [--name <text>] [--description <text>] [--permissions <mode>] [--yes]',
    summary:
      'Create .coder/agents/<id>/ with an agent.json built from the integration catalog, a system.md to write the prompt in, and one sample event per integration for `coder agent run`. Asks for the id, integrations, events, and tools when run in a terminal without them.',
    flags: [
      [
        '--integrations <a,b>',
        'platforms the agent listens to (see coder agent integrations list)',
      ],
      [
        '--triggers <a,b>',
        'events that start tasks, applied to each integration that has them (default: mention)',
      ],
      ['--tools <preset>', 'observe, comment, or write (default: comment)'],
      ['--name <text>', 'display name used in replies (default: the id)'],
      ['--description <text>', 'one line for agent list'],
      ['--permissions <mode>', 'engine permission mode (default: read-only)'],
      ['--yes', 'skip the questions and take the defaults'],
    ],
    examples: [
      ['coder agent init', 'answer the questions, id included'],
      [
        'coder agent init triage --integrations github --triggers issue,mention --tools comment',
        'no questions',
      ],
    ],
  },
  options: {
    ...baseOptions,
    name: str,
    description: str,
    integrations: str,
    triggers: str,
    tools: str,
    permissions: str,
    match: str,
    yes: flag,
  },
  args: 1,
  run: async ({ options, args: [id], cwd }) => {
    const { agents } = await import('../../agent');

    const interactive = canPrompt() && !options.yes;
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
  print: (result, { cwd }) => printAgentInit(result, path.relative(cwd, result.dir)),
});
