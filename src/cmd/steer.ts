import { parseArgs } from '../lib/args.js';
import { fail, requireJob, resolveCwd } from '../lib/ui.js';
import { commandTask } from './task.js';

export async function commandSteer(argv: string[]) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ['cwd', 'model', 'effort', 'permissions'],
    booleanOptions: ['background', 'wait'],
  });
  const cwd = resolveCwd(options);
  const [reference, ...promptParts] = positionals;
  const prompt = promptParts.join(' ').trim();
  if (!reference || !prompt) {
    fail('Missing task id or follow-up text.', {
      hint: ['Usage: coder task steer <task-id> "<follow-up>" [--wait]', 'Help: coder task steer --help'],
    });
  }
  const job = requireJob(cwd, reference);
  if (!job.threadId) {
    fail(`Task ${job.id} has no thread to steer yet (status: ${job.status}).`, {
      hint: `Wait for it to start: coder task stream ${job.id}`,
    });
  }
  if (job.status === 'running') {
    fail(`Task ${job.id} is still running.`, {
      hint: [`Watch it: coder task stream ${job.id}`, `Or stop first: coder task stop ${job.id}`],
    });
  }

  const forwarded = [
    prompt,
    '--resume',
    job.id,
    '--cwd',
    cwd,
    ...(job.agent ? ['--agent', job.agent] : []),
    ...(job.host && job.host !== 'claude' ? ['--host', job.host] : []),
    ...(options.model ? ['--model', options.model] : ['--model', job.model].filter(() => job.model)),
    ...(options.effort ? ['--effort', options.effort] : job.effort ? ['--effort', job.effort] : []),
    ...(options.permissions
      ? ['--permissions', options.permissions]
      : job.permissions
        ? ['--permissions', job.permissions]
        : []),
    ...(options.wait ? ['--wait'] : []),
  ];
  await commandTask(forwarded);
}
