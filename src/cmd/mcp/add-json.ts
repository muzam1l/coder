/** `coder mcp add-json <name> '<entry>'`: paste an entry from any `.mcp.json`. */
import { mcpAddJson } from '../../core/config';
import { baseOptions, flag } from '../../utils/args';
import { command } from '../../cli';
import { printAdded } from './add';

export const commandMcpAddJson = command({
  name: 'mcp add-json',
  help: {
    usage: "coder mcp add-json <name> '<json entry>' [--user]",
    summary:
      'Save an entry pasted from any .mcp.json (command/args/env or url/headers, plus tools).',
    flags: [['--user', 'write ~/.coder config instead of the repo']],
  },
  options: { ...baseOptions, user: flag },
  args: 2,
  run: ({ options, args: [name, json], cwd }) => mcpAddJson(cwd, name, json, options),
  print: printAdded,
});
