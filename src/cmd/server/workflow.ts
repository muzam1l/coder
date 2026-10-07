/** `coder server workflow`: print the GitHub Actions workflow the `github-actions` runner dispatches. */
import process from 'node:process';

import { command } from '../../cli';

export const commandServerWorkflow = command({
  name: 'server workflow',
  globalFlags: { json: false, cwd: false },
  help: {
    usage: 'coder server workflow',
    summary:
      'Print the workflow the github-actions runner dispatches. Save it as .github/workflows/coder-agent.yml in every repo the agent runs on, and set RUNNER=github-actions on the server.',
    examples: [['coder server workflow > .github/workflows/coder-agent.yml', 'add it to a repo']],
  },
  options: {},
  run: async () => {
    const { ACTIONS_WORKFLOW_YAML } = await import('../../server/runners/github-actions');
    return ACTIONS_WORKFLOW_YAML;
  },
  print: yaml => process.stdout.write(yaml),
});
