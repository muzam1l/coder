/** The host skills: `dispatch` for Claude Code, `coder` for ~/.agents hosts and for Cursor. */
import path from 'node:path';

import { SHELL_WAIT } from '../core/types';
import { collectTopics } from '../core/docs';
import { PACKAGE_ROOT } from '../core/runtime';

import { defineSkill, type Skill } from 'contextjsx';

const DESCRIPTION =
  'Use Coder for coding, implementation, or investigation tasks - features, fixes, refactors, debugging, tests, code questions - one coder per focused goal, fanned out in parallel, waiting on each task. Use it when asked, when a task needs another engine (Claude, Codex, custom), or when a subagent is sufficient or required for the task.';

const title = (host?: string) => `# Coder dispatch${host ? ` (${host} host)` : ''}`;

const WORKER =
  'If `CODER_WORKER` is set in your environment, you are a coder worker. Skip this skill and do your assigned work directly; nested dispatch is disabled.\n\nYou dispatch coding tasks through the `coder` runtime instead of implementing them yourself.';

const OVERVIEW =
  '## Overview\n\nCoder delegates coding to supervised subagents of any model - Codex, Claude, or any OpenAI-compatible or local endpoint - from one runtime on every host. Implementation details live in the subagents, so your context stays clean and handoffs are instant. Every task runs sandboxed under unified permissions (read-only, workspace-write, auto), is steerable mid-run, and falls back down the configured chain when an engine cannot start.';

const setup = (command: string, guided?: boolean) =>
  `## Setup\n\nIf \`coder\` is not on PATH, install it yourself without asking: \`npm install -g @wular/coder\`. When a dispatch fails because engines are missing or logged out, run \`${command}\` and follow its output. It checks engines and auth, fixes what it can, prints the exact fix for the rest, and is safe to re-run. Ask the user before installing an engine CLI or changing auth; if it updated codex, tell the user to restart their codex session.${guided ? ' For a guided setup, suggest `/coder:setup`.' : ''}`;

const MCP =
  '## Use Coder over MCP\n\nEach coder command is also an MCP tool with the same arguments, such as `task/run` or `flow/run`; `load_skill` loads a guide.\n\nSetup: `coder setup-host` adds the server. By hand:\n\n```bash\nclaude mcp add coder -- coder mcp\ncodex mcp add coder -- coder mcp\n```\n\nRestart running sessions after adding it.';

const cliSection = (wait: string, gates?: string) =>
  [
    '## Using the CLI',
    '',
    "- The CLI is the reference. `coder --help` and every subcommand's `--help` list the flags and exit codes, and each command prints the recommended next step when it returns. Follow it.",
    '- `coder docs` lists the deeper guides; `coder docs <topic>` prints one.',
    `- ${wait}`,
    ...(gates ? [`- ${gates}`] : []),
  ].join('\n');

const TASKS =
  '## Running tasks\n\nStart with `coder task run --help`. It says how to write a good task and what happens after dispatch. `coder task --help` lists the rest, result, steer, stop, list and approvals. Then run it:\n\n```bash\ncoder task run "Add a /health endpoint in src/server.ts that returns 200 with the git sha. Do not touch routes outside that file."\n```\n\nFollow what it prints.';

const FLOWS =
  '## Flows\n\nWhen the user asks for a repeatable multi-task workflow with verification gates and resume, author a Coder flow instead of hand-fanning tasks. Read `coder docs flows` before writing or editing one, preview with `--dry-run`, and once it runs give the user the real `coder flow watch <run-id>` command.';

const hostSkill = (
  name: string,
  o: { host?: string; setup: string; guided?: boolean; wait: string; gates?: string },
) =>
  defineSkill({
    name,
    description: DESCRIPTION,
    body: [
      title(o.host),
      WORKER,
      OVERVIEW,
      setup(o.setup, o.guided),
      MCP,
      cliSection(o.wait, o.gates),
      TASKS,
      FLOWS,
    ].join('\n\n'),
  });

export { SHELL_WAIT } from '../core/types';

/** Skills by the plugin folder they are written into. */
export const SKILLS = {
  claude: hostSkill('dispatch', {
    host: 'Claude',
    setup: 'coder setup-host claude',
    guided: true,
    wait: 'Run each `coder task result <task-id> --wait` as its own background Bash call (run_in_background), one per task, never several tasks in one call, so each approval and answer re-invokes you.',
  }),
  agents: hostSkill('coder', {
    setup: 'coder setup-host',
    wait: SHELL_WAIT,
    gates:
      'If your harness sandboxes or gates terminal commands (Codex does both), run every `coder` command with escalated permissions; the runtime is a supervisor with its own sandbox and approval policy.',
  }),
  cursor: hostSkill('coder', {
    host: 'Cursor',
    setup: 'coder setup-host',
    wait: SHELL_WAIT,
    gates:
      'If Cursor asks before running `coder` commands, approve or allowlist `coder`; the runtime is a supervisor with its own sandbox and approval policy.',
  }),
};

/** Every bundled guide as a file skill, like the topics of `coder docs`. */
export const GUIDES: Skill[] = collectTopics(PACKAGE_ROOT)
  .filter(topic => topic.file.startsWith('docs/') && topic.name.split('/')[0] !== 'cli')
  .map(topic =>
    defineSkill({
      name: topic.name.replace('/', '-'),
      description: topic.description,
      file: path.join(PACKAGE_ROOT, topic.file),
    }),
  );
