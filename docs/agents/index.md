# Agents

An agent is a reusable teammate. Its `system.md` holds the standing instructions every task starts from: who it is, what it knows, how it answers. Its definition adds engine, model, effort and permissions defaults, the MCP servers it attaches and the [flows](../flows.md) it may run. Run it from the CLI with `coder task run --agent <id> "…"`, where flags override the defaults, from the [dashboard](../dash.md), or from platform events like a Slack DM or a GitHub pull request.

Connected to a platform, an agent listens for the events its triggers name. Each event runs as a task with a fresh checkout, the agent's instructions, the event as its request, and only the platform tools the agent declared; the reply goes back to the thread. A bigger task can run a flow instead, with the event as its `args`.

On each platform an agent is its own app, a GitHub App or a Slack app for example, so it has its own handle and permissions and runs only where it is installed. Agents run on a Coder server: the hosted one, [your own](../self-host.md), or this machine's [dashboard](../dash.md).

## Built-in agent

[`coder`](coder.md) answers engineering questions, reviews pull requests, and makes requested changes. It is on by default wherever its apps are installed; tune or disable it under `agents.coder` in `.coder/config.json` ([Usage](#usage)).

## Your own agents

An agent comes from one of two sources:

- **Dashboard**: made in the agent editor on the [dashboard](../dash.md).
- **Repository**: `coder agent init` scaffolds one, asking its id, platforms, triggers and tools. It is a folder `.coder/agents/<id>/` with an `agent.json` and a `system.md`. A folder in `$CODER_HOME/agents/<id>/` (default `~/.coder/agents`) is yours in every repo, and a repo's folder of the same id wins.

Here is a helper that answers in Slack and on GitHub issues:

`.coder/agents/helper/agent.json`

```json
{
  "name": "Helper",
  "description": "Answers engineering questions about acme/app.",
  "permissions": "read-only",
  "integrations": {
    "slack": {
      "triggers": { "mention": true, "message": { "match": "^help\\b" } },
      "tools": "comment"
    },
    "github": { "triggers": ["mention"], "tools": "observe" }
  }
}
```

`.coder/agents/helper/system.md`

```md
You answer questions about acme/app from its source. Cite file paths.
If asked to change code, describe the change and stop; never promise a PR.
```

From there:

1. Get the agent to a server. A local server reads it from the repo on disk. A cloud server imports it from the dashboard and again on each push to the agents repo once the agent's GitHub App is installed there; `coder agent push` uploads it without a repo.
2. On the dashboard, the agent's Platforms tab creates its app on each platform it uses and installs it; the app's credentials go straight to the server.
3. Events now reach the server, a task runs on its runner, and the reply is posted back. `coder agent run helper <event.json> --server --wait` fires one by hand; without `--server` it runs offline, platform tools off, reply printed. `--server` means `CODER_SERVER`, else the hosted service; give it a URL to pick another.

Only pushes to the agents repo's configured branch are imported. An app created before push events existed needs the `push` event enabled once in its GitHub App settings.

### Definition

`agent.json`. The folder name is the id; the built-in id `coder` is reserved.

| Key                          | Values                                                                                                                                                                                                  | Purpose                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `description`        | Text                                                                                                                                                                                                    | App name and handle; the description is added to the prompt                                                                                                                                                                |
| `engine`, `model`, `effort`  | As in `coder task run`                                                                                                                                                                                  | Engine defaults                                                                                                                                                                                                            |
| `permissions`                | `read-only` (default), `workspace-write`, `auto`                                                                                                                                                        | Agent sandbox mode inside the checkout                                                                                                                                                                                     |
| `integrations.<id>.triggers` | Event names from the [integration](#integrations): a list, or a map of event → `true`, a flow name (repo `.coder/flows` or built-in such as `review`), or `{ "flow", "match", "permissions", "actAs" }` | A list or `true` runs the agent, a flow name runs that flow, `match` is a regex the event text must pass, `permissions` overrides the agent's for this event, `"actAs": "requester"` uses the requester's own GitHub token |
| `integrations.<id>.tools`    | `observe` (default), `comment`, `write`, or tool names from the [integration](#integrations)                                                                                                            | Platform actions the agent uses; also the app's permissions                                                                                                                                                                |
| `mcp`                        | A map of MCP servers in the `.mcp.json` entry shape, as in `coder mcp`                                                                                                                                  | Servers every task of the agent attaches                                                                                                                                                                                   |

`permissions` is about the checkout, `tools` is about the platform. An agent can run any [flow](../flows.md#flows-run-by-an-agent), and the tasks it starts never exceed the agent's `permissions`. The server versions imported definitions and activates a new version when their content changes; recreate the app only when `triggers` or `tools` change.

## Usage

How a repo runs an agent goes under `agents` in its `.coder/config.json` ([Configuration](../config.md)), one entry per agent id. No entry or `true` runs the agent as defined, `false` disables it, an object overrides it:

```json
{
  "agents": {
    "coder": { "model": "sol" },
    "helper": { "integrations": { "slack": { "allowedEvents": ["mention"] } } }
  }
}
```

| Key                                        | Values              | Purpose                                                    |
| ------------------------------------------ | ------------------- | ---------------------------------------------------------- |
| `engine`, `model`, `effort`, `permissions` | As above            | Override the definition                                    |
| `integrations.<id>.allowedTools`           | Preset or tool list | Cap the definition's tools; omit to allow all it asks for  |
| `integrations.<id>.allowedEvents`          | Event names         | Cap the definition's events; omit to allow all it asks for |

Unknown ids, integrations, events, tools, and keys fail validation. Usage is read from the repo the event came from.

## CLI

| Command                                                             | Purpose                                                                |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `coder agent list [--server [url]]`                                 | List agents, with active versions on a server                          |
| `coder agent show <id> [--server [url]]`                            | One agent in full: settings, integrations, triggers, tools             |
| `coder agent init [id]`                                             | Scaffold an agent folder; interactive without flags                    |
| `coder agent push [id] [--server [url]]`                            | Upload one agent, or all of them, without a source repo                |
| `coder agent run <agent> <event.json> [--server [url] [--wait]]`    | Run a recorded event through an agent, on a server or offline          |
| `coder agent usage [--since 7d] [--by agent\|installation\|engine]` | Aggregate usage of this machine's tasks, or a server's with `--server` |
| `coder agent integrations <list\|show <id>>`                        | Integrations with their events and tool presets                        |
| `coder task run --agent <id> "…"`                                   | Run an agent's definition locally; flags override it                   |

## Integrations

An integration gives an agent two things:

1. **Chat.** The agent's own app on the platform. Its events start tasks, and the reply goes back to the same thread. Only linked workspace members can address an agent.
2. **Platform tools.** Actions beyond replying, through the platform's own MCP server or API. They run outside the agent's sandbox, with a token narrowed to the task, and the token never reaches the agent. The presets add up: `comment` includes `observe`, and `write` includes `comment`.

| Platform        | App                                                                                                                                                                              | Events                                                     | Tools                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GitHub          | A [GitHub App](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) per agent                                                           | `mention`, `pull_request`, `issue`, `comment`              | GitHub's [MCP server](https://github.com/github/github-mcp-server); `observe` runs it read-only                        |
| Slack           | A [Slack app](https://api.slack.com/reference/manifests) per agent                                                                                                               | `mention`, `message`, `reaction`, `command`                | `slack_api(method, args)` over the [Web API](https://api.slack.com/methods), with writes limited to the event's thread |
| Microsoft Teams | An [Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) you create, with its endpoint at `<PUBLIC_URL>/hooks/teams?app=<app id>` | `mention`, `message`, `reaction`                           | None yet                                                                                                               |
| Gmail           | Your Google OAuth client plus a [Pub/Sub push](https://developers.google.com/workspace/gmail/api/guides/push) to `<PUBLIC_URL>/hooks/gmail?app=<client id>`                      | `mail`: only from linked senders whose domain passes DMARC | None yet                                                                                                               |
| Linear          | Your [Linear OAuth app](https://linear.app/developers/agents), with webhooks to `<PUBLIC_URL>/hooks/linear?app=<client id>`                                                      | `mention`: an agent session                                | None yet                                                                                                               |

`coder agent integrations show <id>` lists each event and each preset's exact tools or scopes. A host turns platforms off with `SERVER_INTEGRATIONS` ([Self-hosting](../self-host.md)).

Need another integration or a missing event or tool? [Open an issue](https://github.com/muzam1l/coder/issues).
