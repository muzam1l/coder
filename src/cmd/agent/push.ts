/** `coder agent push [id]`: upload this repo's agents to a server. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { baseOptions, flag, optStr, str } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';

export const commandAgentPush = command({
  name: 'agent push',
  help: {
    usage: 'coder agent push [id] [--server [url]] [--json] [--cwd <dir>]',
    summary:
      'Upload one workspace agent, or every agent in .coder/agents when no id is given. The server creates a new immutable version only when its definition, prompt, or files changed.',
    flags: [SERVER_FLAG],
    examples: [['coder agent push helper', 'upload helper']],
  },
  options: { ...baseOptions, server: optStr, workspace: str, yes: flag },
  args: 1,
  run: async ({ options, args: [id], cwd }) => {
    const { agents } = await import('../../agent');
    return agents.push(id, { ...options, cwd, organization: options.workspace });
  },
  print: results => {
    for (const result of results)
      process.stdout.write(
        result.unchanged
          ? `Pushed ${outStyle.bold(result.id)} unchanged (version ${result.version})\n`
          : `Pushed ${outStyle.bold(result.id)} as version ${result.version}\n`,
      );
  },
});
