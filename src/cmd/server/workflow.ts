/** `coder server workflow`: print the GitHub Actions workflow the `github-actions` runner dispatches. */
import process from 'node:process';

import { command } from '../../cli';

export const commandServerWorkflow = command({
  name: 'workflow',
  description: 'print the GitHub Actions workflow for RUNNER=github-actions',
  usage:
    'Print the workflow the github-actions runner dispatches. Save it as .github/workflows/coder-agent.yml in every repo the agent runs on, and set RUNNER=github-actions on the server.',
  access: 'read',
  approvalPolicy: 'deny',
  globalFlags: { json: false, cwd: false },
  cli: {
    examples: ['coder server workflow > .github/workflows/coder-agent.yml  # add it to a repo'],
  },
  run: async () => {
    const { actionsWorkflow } = await import('../../server/runners/kinds/github-actions');
    return actionsWorkflow();
  },
  print: yaml => process.stdout.write(yaml),
});
