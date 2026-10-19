/** `coder task <sub>`: the task command group. */
import { group } from '../../cli';
import { commandApprovals } from './approvals';
import { commandApprove } from './approve';
import { commandArchive } from './archive';
import { commandAsk } from './ask';
import { commandDelete } from './delete';
import { commandTasks } from './list';
import { commandResult } from './result';
import { commandTask } from './run';
import { commandSteer } from './steer';
import { commandStop } from './stop';
import { commandWatch } from './watch';

export const commandTaskGroup = group({
  name: 'task',
  description: 'run, follow and steer coding tasks',
  commands: [
    commandTask,
    commandTasks,
    commandResult,
    commandWatch,
    commandSteer,
    commandAsk,
    commandStop,
    commandArchive,
    commandDelete,
    commandApprovals,
    commandApprove,
  ],
  aliases: { stream: 'watch', ls: 'list' },
});
