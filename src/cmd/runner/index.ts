/** `coder runner <add|default|test|serve|list|rename|remove>`: a group; the work is in the subcommands. */
import { group } from '../../cli';
import { commandRunnerAdd } from './add';
import { commandRunnerDefault } from './default';
import { commandRunnerList } from './list';
import { commandRunnerRemove } from './remove';
import { commandRunnerRename } from './rename';
import { commandRunnerServe } from './serve';
import { commandRunnerTest } from './test';

export const commandRunner = group({
  name: 'runner',
  description: "run your server's tasks on this machine",
  usage: "Run your Coder server's tasks on your own machine, reached through any tunnel.",
  commands: [
    commandRunnerAdd,
    commandRunnerDefault,
    commandRunnerTest,
    commandRunnerServe,
    commandRunnerList,
    commandRunnerRename,
    commandRunnerRemove,
  ],
});
