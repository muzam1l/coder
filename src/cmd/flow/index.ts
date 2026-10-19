/** `coder flow <sub>`: the flow command group. See docs/flows.md. */
import { group } from '../../cli';
import { commandArchive } from './archive';
import { commandDelete } from './delete';
import { commandDiscover } from './discover';
import { commandList } from './list';
import { commandResult } from './result';
import { commandResume } from './resume';
import { commandRun } from './run';
import { commandStop } from './stop';
import { commandWatch } from './watch';

export const commandFlow = group({
  name: 'flow',
  description: 'orchestrate many coder tasks from one TypeScript file',
  usage:
    'Orchestrate many coder tasks with a plain TypeScript file: dispatch, gates,\nconcurrency, journaling, and resume. Flows live in .coder/flows/ (workspace)\nor ~/.coder/flows/ (global). See `coder docs flows`.',
  commands: [
    commandRun,
    commandList,
    commandDiscover,
    commandResult,
    commandWatch,
    commandStop,
    commandResume,
    commandArchive,
    commandDelete,
  ],
  aliases: { stream: 'watch', ls: 'list' },
});
