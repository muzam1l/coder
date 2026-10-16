import { command } from '../../cli';
import { driveRun } from '../../flow/runs';
import { str } from '../../utils/args';

export const commandDrive = command({
  name: 'flow drive',
  options: { cwd: str },
  args: 1,
  run: ({ args: [id], cwd }) => driveRun(id!, cwd),
});
