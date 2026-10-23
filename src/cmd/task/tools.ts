import { strList } from '../../utils/args';
import { command } from '../../cli';

/** A task's tools over stdio. */
export const commandTools = command({
  name: 'tools',
  description: "serve a task's tools over stdio",
  access: 'write',
  args: { tools: strList('the tools to serve: review, reply, react, history') },
  globalFlags: { json: false, cwd: false },
  cli: { positional: ['tools'] },
  mcp: false,
  async run({ args }) {
    const { taskApp, taskTools } = await import('../../core/task/context/tools');
    const { serve } = await import('contextjsx/serve');
    const names = args.flat();
    const unknown = names.find(name => !taskApp.commands?.some(command => command.name === name));
    if (unknown) throw new Error(`Unknown task tool "${unknown}"`);

    await (
      await serve(taskTools(names), 'stdio')
    ).done;
  },
});
