/** @jsxImportSource contextjsx */

/** Model-facing commands, docs and host skills (`dispatch` for Claude Code, `coder` for ~/.agents hosts and Cursor), sharing the CLI arguments and finite command handlers. */
import path from 'node:path';

import { defineApp, defineSkill, type Namespace, type Skill } from 'contextjsx';

import { cli } from '../cmd';
import { boundCommands, boundNamespace, commandForMcp, namespaceForMcp } from '../core/tools';
import { PACKAGE_ROOT, readVersion } from '../core/runtime';
import { SHELL_WAIT } from '../core/types';
import { collectTopics } from '../core/docs';

const DESCRIPTION =
  'Use Coder for coding, implementation, or investigation tasks - features, fixes, refactors, debugging, tests, code questions - one coder per focused goal, fanned out in parallel, waiting on each task. Use it when asked, when a task needs another engine (Claude, Codex, custom), or when a subagent is sufficient or required for the task.';

const title = (host?: string) => `# Coder dispatch${host ? ` (${host} host)` : ''}`;

const WORKER =
  'If `CODER_WORKER` is set in your environment, you are a coder worker. Skip this skill and do your assigned work directly; nested dispatch is disabled.\n\nYou dispatch coding tasks through the `coder` runtime instead of implementing them yourself.';

const OVERVIEW =
  '## Overview\n\nCoder delegates coding to supervised subagents of any model - Codex, Claude, or any OpenAI-compatible or local endpoint - from one runtime on every host. Implementation details live in the subagents, so your context stays clean and handoffs are instant. Every task runs sandboxed under one access setting (read-only or auto), is steerable mid-run, and falls back down the configured chain when an engine cannot start.';

const setup = (command: string, guided?: boolean) =>
  `## Setup\n\nIf \`coder\` is not on PATH, install it yourself without asking: \`npm install -g @wular/coder\`. When a dispatch fails because engines are missing or logged out, run \`${command}\` and follow its output. It checks engines and auth, fixes what it can, prints the exact fix for the rest, and is safe to re-run. Ask the user before installing an engine CLI or changing auth; if it updated codex, tell the user to restart their codex session.${guided ? ' For a guided setup, suggest `/coder:setup`.' : ''}`;

const MCP =
  '## Use Coder over MCP\n\nEach coder command is also an MCP tool with the same arguments, such as `task/run` or `flow/run`; `load_skill` loads a doc.\n\nSetup: `coder setup-host` adds the server. By hand:\n\n```bash\nclaude mcp add coder -- coder mcp\ncodex mcp add coder -- coder mcp\n```\n\nRestart running sessions after adding it.';

const cliSection = (wait: string, gates?: string) =>
  [
    '## Using the CLI',
    '',
    "- The CLI is the reference. `coder --help` and every subcommand's `--help` list the flags and exit codes, and each command prints the recommended next step when it returns. Follow it.",
    '- `coder docs` lists the docs; `coder docs <topic>` prints one.',
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

/** Every bundled doc as a file skill, like the topics of `coder docs`. */
export const DOCS: Skill[] = collectTopics(PACKAGE_ROOT)
  .filter(topic => topic.file.startsWith('docs/') && topic.name.split('/')[0] !== 'cli')
  .map(topic =>
    defineSkill({
      name: topic.name.replace('/', '-'),
      description: topic.description,
      file: path.join(PACKAGE_ROOT, topic.file),
    }),
  );

/** Coder's MCP app: every CLI command as a tool, and the docs. Cloud tasks get a narrower view (`cloudApp`). */
export const app = defineApp({
  ...cli,
  version: readVersion(),
  instructions: (
    <>
      Coder runs coding agents: subagents on this machine for the work in front of you, and
      always-on agents in Coder Cloud that work in GitHub, Slack and other apps. On this machine,
      task/run starts a subagent on any engine (Claude, Codex or a custom model). task/result
      returns its answer, task/steer continues it, and task/approve answers its permission requests.
      flow/run runs a TypeScript flow of many tasks; review reviews a diff. For Coder Cloud, pass
      server to the same tools; sign in once with `coder auth login` in a terminal. agent/push
      publishes an agent, and connection/add gives tasks accounts, keys and MCP servers. Every
      result lists its next steps; follow them.
    </>
  ),
  commands: cli.commands.map(command => commandForMcp(command, [])),
  namespaces: [...cli.namespaces.map(namespace => namespaceForMcp(namespace))],
  skills: [SKILLS.agents, ...DOCS],
});

/** The agent namespace without the integrations catalog, which a task has no use for. */
const withoutAuthoring = (namespace: Namespace): Namespace =>
  namespace.name === 'agent'
    ? { ...namespace, namespaces: namespace.namespaces?.filter(child => child.name !== 'integrations') }
    : namespace;

/** Coder's MCP app inside a cloud task: the task's own server and agent, its children, and the workspace's lists; nothing on the machine. */
export const cloudApp = defineApp({
  ...cli,
  version: readVersion(),
  description:
    "This agent's tasks and settings, and the workspace's agents, models, credentials and connections",
  instructions: (
    <>
      Coder turns any model into an agent you own. You are one of this workspace's agents, always on
      in Coder Cloud, and this server is bound to the workspace and to you. Each result ends with its
      dashboard link and next steps; follow them, and offer the link when a step is not yours. A
      command that asks waits for Approve or Deny in the thread.
      <tasks>
        task/run starts a child task with your agent, its connections and repositories, and at most
        your access; give it the goal, paths, constraints and context only you have. The other task
        tools manage your children only; task/approve answers their escalations.
      </tasks>
      <agents>
        agent/show gives this agent's platforms, installations and settings. agent/settings changes
        its engine, model and effort at once when the person asking is a linked member; its other
        settings ask.
      </agents>
      <settings>
        <connections>
          connection/list gives every member's and the workspace's connections with owner and
          status; rows marked asker are the asking member's.
        </connections>
        <models>model/update, alias, enable and disable ask.</models>
        <credentials>credentials/list gives the keys by variable.</credentials>
        <runners>runner/default asks.</runners>
        Every create, add, remove and delete returns a prefilled link to its page under
        **# Settings** or **# Agents**; give it to the person, who finishes there. Never ask for a
        key in the chat.
      </settings>
    </>
  ),
  commands: boundCommands(cli.commands, []),
  namespaces: cli.namespaces
    .map(namespace => boundNamespace(withoutAuthoring(namespace)))
    .filter((namespace): namespace is Namespace => Boolean(namespace)),
  // The host dispatch skill is for a machine's own agent; a cloud task reaches Coder through this server.
  skills: DOCS,
});
