---
description: Agents, their system.md and agent.json, platform apps, events and settings.
---

# Agents

An agent is a reusable teammate. Its `system.md` holds the instructions every task starts from. Its definition adds a default model and MCP servers. It runs from the CLI (`coder task run --agent <id> "…"`, flags override the defaults), from the [dashboard](../dash.md), or from platform events such as a Slack DM or a GitHub pull request.

On each platform an agent is its own app, such as a GitHub App or a Slack app, with its own handle and permissions, and it runs only where installed.
- Each event it listens for runs as a task with the agent's instructions, the event as the request, and the platform tools of every installation of its apps.
- A GitHub event also checks out its repository.
- The reply goes back to the thread.
- Later messages in that conversation, from anyone, steer the task while it runs and resume it once it has finished.

Agents run on a Coder server: the hosted one, a [self-hosted](../self-host.md) one, or this machine's [dashboard](../dash.md). Tasks get the workspace's [connections](../connections.md), narrowed by the agent's Connections setting.

## Built-in agent

[`coder`](coder.md) answers engineering questions, reviews pull requests and makes requested changes. It's on wherever its apps are installed; tune or disable it under `agents.coder` ([Usage](#usage)).

## Defining an agent

- **Dashboard:** **# Agents → [New agent]**.
- **Repository:** `coder agent init` scaffolds `.coder/agents/<id>/` with an `agent.json` and a `system.md`. A folder in `$CODER_HOME/agents/<id>/` (default `~/.coder/agents`) applies in every repo, and a repo's folder of the same id wins.

`.coder/agents/helper/agent.json`:

```json
{
  "name": "Helper",
  "description": "Answers engineering questions about acme/app.",
  "access": "read-only",
  "integrations": {
    "slack": { "events": { "mention": true, "channel": { "match": "^help\\b" } } },
    "github": { "events": ["mention"] }
  }
}
```

`.coder/agents/helper/system.md`:

```md
You answer questions about acme/app from its source. Cite file paths.
```

Then:
1. **Get it to a server.** A local server reads the repo. A cloud server imports it from the dashboard, then on each push to the agents repo's branch once its GitHub App is installed there, as a new version. `coder agent push` uploads it without a repo.
2. **Install it.** **# Agents → *agent* → (Platforms)** creates and installs its app on each platform. An app is private, or public where the platform allows it (GitHub, Linear). An install started on the platform signs the installer in to Coder, and binds to the app's workspace when they're a member.
3. **Try it.** `coder agent run helper <event.json> --server --wait` fires one event. Without `--server` it runs offline, with platform tools off.

| Key | Values | Purpose |
| --- | --- | --- |
| `name`, `description` | Text | App name and handle; the description joins the prompt |
| `model` | A [model spec](../models.md#pick-a-model) | Default model |
| `integrations.<id>.events` | A list of [events](#integrations), or a map of event → `true` or `{ "match" }` | `match` is a regex the event text must pass |
| `access` | `read-only`, or `auto` (default) | Its tasks, platforms, connections and app permissions; a task, flow or connection can only lower it |
| `mcp` | MCP servers in the [`.mcp.json` shape](../connections.md#mcp-servers-in-config) | Servers every task of the agent attaches |

The folder name is the id; `coder` is reserved.

## Usage

A repo's `.coder/config.json` sets how it runs each agent under `agents`. No entry or `true` runs it as defined, `false` disables it, and an object overrides it:

```json
{ "agents": { "coder": { "model": "sol" }, "helper": { "integrations": { "slack": { "allowedEvents": ["mention"] } } } } }
```

| Key | Purpose |
| --- | --- |
| `model` | Replace the definition's model |
| `connections` | Narrow the connections; omit for all granted |
| `access` | `read-only` lowers it |
| `runner` | Start its tasks on this runner, by id or name |
| `integrations.<id>.allowedEvents` | Cap the definition's events |
| `disabled` | `true` disables it and keeps its settings |

Unknown ids, integrations, events and keys fail validation. Usage comes from the repo the event came from. **# Agents → *agent* → (Settings) → (Manage) → [Disable]** stops any agent, built-in ones included, in that workspace only. Commands: [`coder agent`](../cli/agent.md).

## Integrations

An integration gives an agent two things on a platform:

- **Chat:** the agent's own app. Its events start tasks, one per issue, pull request or Slack thread, and each reply goes to the thread that asked. Anyone the platform lets write there can address it: on GitHub an organization member with write access to the repository or a bot's pull request from a branch of it, on Slack and Linear a full member, never a guest.
- **Platform tools:** each platform's MCP server, one per installation, outside the agent's sandbox, at the agent's access. Read-only exposes only the tools the server marks read-only. Who they act as: [Connections](../connections.md#workspace-or-personal).

| Platform | App | Events | Workspace | Personal |
| --- | --- | --- | --- | --- |
| GitHub | A GitHub App per agent | `mention`, `pull_request`, `issue`, `comment` | [`github-mcp-server`](https://github.com/github/github-mcp-server) on the installation token | The same, on the person's token |
| Slack | A Slack app per agent | `mention`, `dm`, `channel`, `command` | [Slack MCP Server](https://github.com/korotovsky/slack-mcp-server) on the bot token: the bot's channels, no search | [Slack MCP](https://docs.slack.dev/ai/slack-mcp-server) on the person's token, with search |
| Linear | A Linear OAuth app, webhooks to `<PUBLIC_URL>/hooks/linear?app=<client id>` | `mention`, `issue`, `comment` | [Linear's MCP](https://linear.app/docs/mcp) on the app's token | The same, on the person's token |

- **Slack:** `dm` takes every message in direct and group DMs, and `channel` every message in the agent's channels, up to Slack's 30,000 events per workspace per app per hour.
- **Linear:** `mention` takes a comment naming `@<app>`, `issue` issues people create or change, and `comment` every other comment by a person; replies go in the asking comment's thread. All need Issues and Comments ticked in the app's webhook settings.
- **Slack:** the app's Home tab shows the agent and how to use it, and links to this server's tasks and agents unfurl into a short card.
- **Every platform:** an edited message counts like a new one, unless it already started or steered a turn. A message the agent must answer gets 👀 until the first reply.

Publishing an agent updates its apps' events and permissions: Coder updates a Slack app itself, and lists the changes for GitHub and Linear (**[Update on *platform*]** later). `coder agent integrations show <id>` lists each event's and preset's tools. A host limits the platforms it offers with `SERVER_INTEGRATIONS` ([Self-host](../self-host.md)).
