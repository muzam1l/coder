<div align="center">

# Coder

**The runtime for agents, your rules, any model, everywhere.**

</div>

Coder turns any model into an agent you own: an always-on teammate in Slack, GitHub, Linear and your other apps. It does the work and replies in the same thread. Run it in [Coder Cloud](https://coder.wular.ai), or hand it tasks right from your local harness.

## Why Coder

- **Always on.** Your agents run in the cloud, connected to GitHub, Slack and any other app, each task in its own workspace with only the access you grant.
- **In your harness too.** Hand tasks off to subagents from Claude Code, Codex or another harness. Your conversation stays about intent, and only the result comes back.
- **Your agents, your team.** Build agents with their own instructions, events and tools, and share them, with their credentials, across your workspace.
- **Built-in review.** Review any diff with a read-only agent that checks every finding against your repo.
- **Any model.** Claude, Codex or any other model, from your subscriptions, an API endpoint, or your own machine. Pick per task.
- **Fully controlled.** One permission model across every engine, live visibility into every task, and steering mid-run.
- **Flows and SDK.** Orchestrate whole waves of tasks from one TypeScript file, or drive everything from your own code.

## Get started

| I want to                                                                          | Start with                                      |
| ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| Run my agents always on in the cloud, connected to GitHub, Slack and any other app | [Coder Cloud](#coder-cloud)                     |
| Hand tasks off from Claude Code, Codex or another harness                          | [In your local harness](#in-your-local-harness) |
| Script tasks, reviews and flows from code                                          | [From code](#from-code)                         |

## Coder Cloud

Your agents, always on at **[coder.wular.ai](https://coder.wular.ai)**. Connect GitHub, Slack or any other app, and they work right inside it. No download, no setup:

1. **Sign in** at [coder.wular.ai](https://coder.wular.ai).
2. **Connect a platform**: GitHub, Slack, Linear or any other app in the catalog.
3. **Mention `@coder`** in an issue, pull request or thread. It does the work and replies in the same thread.

- **Your agents.** Instructions, events and tools, set in the dashboard or in `.coder/agents/` in your repo.
- **Every app, one dashboard.** GitHub, Slack and the rest of the integration catalog.
- **Scoped access.** Each task gets a fresh workspace and a platform token limited to that task.
- **A built-in agent.** `coder` answers questions, reviews pull requests, and opens them for requested changes.

[Dashboard](docs/dash.md) · [Agents](docs/agents/index.md)

## In your local harness

**Install.**

```bash
npm install -g @wular/coder
```

**Add it to your host.**

| Host                                                           | Install                                                                                                                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                                                    | `coder setup-host claude`<br>or, inside Claude Code:<br>`/plugin marketplace add muzam1l/coder`<br>`/plugin install coder@coder-plugins`<br>`/coder:setup` |
| Codex, Pi, OpenCode and any host that reads `~/.agents/skills` | `coder setup-host agents`                                                                                                                                  |

`coder setup-host` adds Coder's MCP server as well; more in [setup-host](docs/cli/index.md).

**Connect a model.** Coder uses the engines you're signed in to, or your own model ([Models](docs/models.md)).

```bash
npm install -g @openai/codex && codex login
# and/or
npm install -g @anthropic-ai/claude-code && claude auth login
```

**Use it.** Ask your host:

> Use Coder to explain the directory structure of the workspace.

To make it the default, add this line to your project's `AGENTS.md` or `CLAUDE.md`:

```md
Always use Coder for implementation and exploration.
```

Every task runs under the access you set and stays yours to watch, steer or stop. See them all in the browser:

```bash
coder dash
```

> **Recommended setup:** Claude Code as the host (Fable, low or medium effort) and Codex (sol) as the engine, the best split of performance and cost.

[Models](docs/models.md) · [Configuration](docs/config.md) · [Approvals](docs/approvals.md) · [Connections](docs/connections.md)

## From code

Your host drives tasks itself, but everything is scriptable:

```bash
coder run "<text>"                     # dispatch a task (--wait to block for the answer)
coder list                             # recent tasks (running + just stopped)
coder result [task-id]                 # status + final answer (--wait blocks until done)
coder task steer <task-id> "<text>"    # continue a task with new instructions
coder task ask <task-id> "<question>"  # ask about a task without interrupting it
coder task stop <task-id>              # interrupt it
coder task watch [task-id]             # stream the live transcript
coder review --pr 42 --post            # read-only review, posted inline
```

Any `[task-id]` defaults to the most recent task.

For a repeatable workflow, ask your host to write a flow:

> Create a Coder flow that fixes every failing test file: one task per file, gated on its tests passing.

A flow is one TypeScript file that fans out tasks, with verification gates and resume after a crash:

```ts
// .coder/flows/fix-tests.ts
import { z } from 'zod';
import { task, gate, pipeline } from '@wular/coder/flow';

const failing = await task('Run `bun test` and list the failing test files.', {
  returns: z.object({ files: z.array(z.string()) }),
});

export default await pipeline(
  failing.data.files,
  file => task(`Fix the failing tests in ${file}.`, { name: file }),
  (r, file) => gate(`bun test ${file}`),
);
```

[CLI](docs/cli/index.md) · [Flows](docs/flows.md) · [Review](docs/review.md) · [SDK](docs/sdk.md)

## Docs

Everything else is at **[coder.wular.ai/docs](https://coder.wular.ai/docs)**.

`coder --help` lists every command, and `coder docs [topic]` prints the bundled docs. `coder upgrade` keeps the CLI and host plugins current.
