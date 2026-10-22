/** `coder agent push [id]`: upload this repo's agents to a server. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { serverOptions, str } from '../../utils/args';
import { command } from '../../cli';

export const commandAgentPush = command({
  name: 'push',
  description: 'upload workspace agents to a Coder server',
  usage:
    'Upload one workspace agent, or every agent in .coder/agents when no id is given. The server creates a new immutable version only when its definition, prompt, or files changed.',
  access: 'write',
  approvalPolicy: 'deny',
  args: { id: str('the agent (default: every workspace agent)'), ...serverOptions },
  cli: { positional: ['id'], examples: ['coder agent push helper  # upload helper'] },
  run: async ({ options, args: [id], cwd }) => {
    const { agents } = await import('../../agent');
    return agents.push(id, { ...options, cwd, organization: options.workspace });
  },
  print: results => {
    for (const result of results) {
      process.stdout.write(
        result.unchanged
          ? `Pushed ${outStyle.bold(result.id)} unchanged (version ${result.version})\n`
          : `Pushed ${outStyle.bold(result.id)} as version ${result.version}\n`,
      );
      for (const app of result.apps ?? [])
        if (app.error) process.stderr.write(`${app.error}\n`);
        else if (app.drift)
          process.stderr.write(
            `${app.name} needs changes on ${app.integration}; open it on the agent's Platforms tab and click Update.\n`,
          );
    }
  },
});
