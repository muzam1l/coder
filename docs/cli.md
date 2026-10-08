# CLI reference

Every command, grouped by what it acts on. Run `coder <command> --help` for the full flags, examples and exit codes of any one of them. Commands that take a `[task-id]` or `[run-id]` default to your most recent one.

## Tasks

| Command                                      | What it does                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `coder run "<text>"`                         | Dispatch a task in the background and print its id. Short for `coder task run`.                |
| `coder list`                                 | Recent tasks, running and just stopped. `--running`, `--stopped`, `--archived`, `--limit <n>`. |
| `coder result [task-id]`                     | Status and final answer. `--wait` blocks until it's ready.                                     |
| `coder task watch [task-id]`                 | Stream the live transcript.                                                                    |
| `coder task steer <task-id> "<text>"`        | Continue the task's thread with new instructions, mid-run.                                     |
| `coder task ask <task-id> "<question>"`      | Ask about a task without interrupting it.                                                      |
| `coder task stop <task-id>`                  | Interrupt a running task.                                                                      |
| `coder task approvals [task-id]`             | Approvals waiting on you, across tasks or for one.                                             |
| `coder task approve [task-id] <approval-id>` | Accept an escalated permission. `--deny` rejects it.                                           |
| `coder task archive <task-id>`               | Hide a stopped task from the list. `--all-stopped` for all of them.                            |
| `coder task delete <task-id>`                | Delete a task's record. `--all-archived` for all archived ones.                                |

### `coder run` flags

| Flag                               | What it does                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `--wait`                           | Run in the foreground and print the answer.                                      |
| `--engine <codex\|claude\|custom>` | Engine to use. Defaults to the first in the chain.                               |
| `--model <alias\|slug>`            | Model to use, built-in or one of yours (`coder model list`).                     |
| `--effort <low\|medium\|high>`     | Reasoning effort.                                                                |
| `--permissions <mode>`             | `read-only`, `workspace-write` or `auto` (the default).                          |
| `--agent <id>`                     | Run as a repo agent: its instructions, engine settings, MCP servers and flows.   |
| `--system <text>`                  | Standing instructions prepended to the task.                                     |
| `--mcp <names\|all\|json>`         | Attach MCP servers by name, or inline.                                           |
| `--add-dir <dir>`                  | Give the task another directory beyond `--cwd`. Repeatable.                      |
| `--output-schema <json>`           | JSON Schema the answer must match.                                               |
| `--name <name>`                    | Label the task in `list` and `result`.                                           |
| `--resume <task-id>`               | Continue that task's thread instead of starting fresh.                           |
| `--server [url]`                   | Run on your Coder server and follow it here. `--repo` and `--runner` pick where. |

## Flows

| Command                       | What it does                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `coder flow run <name\|path>` | Run a flow in the background. `--wait` follows it live, `--dry-run` prints every prompt and gate first. |
| `coder flow discover`         | Flows you can run here, from the workspace and globally.                                                |
| `coder flow list`             | Recent runs.                                                                                            |
| `coder flow watch [run-id]`   | Watch a run live.                                                                                       |
| `coder flow result [run-id]`  | Progress and result across the run.                                                                     |
| `coder flow stop [run-id]`    | Stop a run and its still-running tasks.                                                                 |
| `coder flow resume [run-id]`  | Continue a stopped or edited run.                                                                       |
| `coder flow archive <run-id>` | Hide a run. `--all-stopped` for all of them.                                                            |
| `coder flow delete <run-id>`  | Delete a run's record. `--all-archived` for all archived ones.                                          |

Pass a flow's input as `key=value` pairs or `--args '<json>'`. `--concurrency` and `--max-tasks` cap how wide it goes.

## Review

| Command                      | What it does                                                         |
| ---------------------------- | -------------------------------------------------------------------- |
| `coder review`               | Review this branch against the merge-base with the default branch.   |
| `coder review --pr <n\|url>` | Review a pull request. `--post` posts inline comments and a summary. |

Narrow it with `--base`, `--head`, `--since <sha>`, `--path` and `--exclude`. `--engine`, `--model` and `--effort` pick what runs the review.

## Models

| Command                                                | What it does                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `coder model list`                                     | Built-in models, your own, and aliases.                                    |
| `coder model add <name> --base-url <url> --model <id>` | Connect any OpenAI-compatible endpoint. `--env-key <VAR>` for its API key. |
| `coder model update <name>`                            | Change a model in place.                                                   |
| `coder model remove <name>`                            | Delete one of your models.                                                 |
| `coder model alias <name> <spec>`                      | Name a shortcut, like `fast codex:luna`. `unalias` removes it.             |
| `coder model disable <name>`                           | Take a model out of rotation. `enable` brings it back.                     |

## Configuration and MCP

| Command                              | What it does                                                             |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `coder config list`                  | The effective configuration.                                             |
| `coder config get <key>`             | Read one value, like `engines.codex.model`.                              |
| `coder config set <key> <value>`     | Write a value. `--workspace` writes to this repo's `.coder/config.json`. |
| `coder config unset <key>`           | Remove a value.                                                          |
| `coder mcp add <name> -- <command>`  | Add a stdio MCP server. `--url <url>` adds a remote one.                 |
| `coder mcp add-json <name> '<json>'` | Add an entry in `.mcp.json` shape.                                       |
| `coder mcp list`                     | Configured MCP servers.                                                  |
| `coder mcp rm <name>`                | Remove one.                                                              |

## Agents

| Command                                | What it does                                                   |
| -------------------------------------- | -------------------------------------------------------------- |
| `coder agent list`                     | Agents in this workspace, or on your server.                   |
| `coder agent show <id>`                | One agent in full: settings, integrations, triggers, tools.    |
| `coder agent init [id]`                | Scaffold an agent in `.coder/agents/`.                         |
| `coder agent run <agent> <event.json>` | Run a recorded event through an agent, offline or on a server. |
| `coder agent push [id]`                | Upload workspace agents to your server.                        |
| `coder agent integrations list`        | The apps an agent can connect to. `show <id>` for one.         |
| `coder agent usage`                    | Usage by agent, installation or engine.                        |

## Servers

| Command                                 | What it does                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `coder auth login`                      | Sign in to Coder Cloud. `--server <url>` for a self-hosted one.                                |
| `coder auth status`                     | Where you're signed in. `logout` forgets the session.                                          |
| `coder credentials list`                | Engine credentials on your server. `add`, `login`, `default` and `remove` manage them.         |
| `coder runner serve --url <public url>` | Run your server's tasks on this machine.                                                       |
| `coder runner list`                     | Your runners and the workspace's. `add`, `test`, `default`, `rename` and `remove` manage them. |
| `coder server serve`                    | Run a Coder server. See [Self-hosting](self-host.md).                                          |
| `coder server migrate`                  | Apply pending database migrations.                                                             |
| `coder server rotate-key`               | Re-seal stored secrets with a new `SERVER_ENCRYPTION_KEY`.                                     |
| `coder server app create <integration>` | Create the built-in agent's public app on a platform.                                          |
| `coder server workflow`                 | Print the GitHub Actions workflow the `github-actions` runner uses.                            |

## Setup and upkeep

| Command                             | What it does                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `coder setup-host [claude\|agents]` | Install or repair the host plugin, and check engines and auth.                                  |
| `coder dash`                        | Your tasks, agents and settings in the browser. Short for `coder server serve` on this machine. |
| `coder upgrade`                     | Update the CLI and host plugins. `--cli-only` or `--plugins-only` to narrow it.                 |
| `coder docs [topic]`                | Print a bundled guide.                                                                          |

Set `CODER_NO_UPDATE_CHECK=1` to silence the update notice.

## Global flags

| Flag              | What it does              |
| ----------------- | ------------------------- |
| `--json`          | Machine-readable output.  |
| `--cwd <dir>`     | Act on another workspace. |
| `-h`, `--help`    | Help for any command.     |
| `-v`, `--version` | Print the version.        |

## Exit codes

`coder run --wait` and `coder result --wait` exit with:

| Code | Meaning                                             |
| ---- | --------------------------------------------------- |
| 0    | The task completed.                                 |
| 1    | The task failed or was cancelled.                   |
| 3    | No engine could start.                              |
| 4    | An approval is pending. Answer it, then wait again. |
| 130  | You detached from the wait. The task keeps running. |
