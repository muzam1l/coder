# Agents

An agent is a reusable teammate. Its `system.md` holds the standing instructions every task starts from: who it is, what it knows, how it answers. Its definition adds engine, model, effort and permissions defaults, the MCP servers it attaches and the [flows](../flows.md) it may run. Run it from the CLI with `coder task run --agent <id> "…"`, where flags override the defaults, from the [dashboard](../dash.md), or from platform events like a Slack DM or a GitHub pull request.

Connected to a platform, an agent listens for the events it names. Each event runs as a task with the agent's instructions, the event as its request, and the platform tools of every installation of the agent's apps; a GitHub event also checks out its repository, and any task can clone the agent's GitHub repositories. The reply goes back to the thread. Later messages in that conversation, from anyone, steer its task while it runs and resume it once it has finished. A bigger task can run a flow instead, with the event as its `args`.

On each platform an agent is its own app, a GitHub App or a Slack app for example, so it has its own handle and permissions and runs only where it is installed. Agents run on a Coder server: the hosted one, [your own](../self-host.md), or this machine's [dashboard](../dash.md).

## Connections

A connection gives tasks access to an MCP service, your own account on an integration, or an API key passed as one environment variable, such as `GROQ_API_KEY`. Add one under Settings → Connections or with `coder connection add`; an API key is kept as a credential, so rotating the credential rotates the connection. Tasks started by members receive workspace connections and that member’s own connections, narrowed by the agent’s Connections setting and `coder task run --connections`; outsider events receive none. A connection's access is Default, which follows the agent's, Read-only or Read-write. Read-only gives the engine only the tools the server marks read-only.

## Built-in agent

[`coder`](coder.md) answers engineering questions, reviews pull requests, and makes requested changes. It is on by default wherever its apps are installed; tune or disable it under `agents.coder` in `.coder/config.json` ([Usage](#usage)).

## Your own agents

An agent comes from one of two sources:

- **Dashboard**: made in the agent editor on the [dashboard](../dash.md).
- **Repository**: `coder agent init` scaffolds one, asking its id, platforms, events and access. It is a folder `.coder/agents/<id>/` with an `agent.json` and a `system.md`. A folder in `$CODER_HOME/agents/<id>/` (default `~/.coder/agents`) is yours in every repo, and a repo's folder of the same id wins.

Here is a helper that answers in Slack and on GitHub issues:

`.coder/agents/helper/agent.json`

```json
{
  "name": "Helper",
  "description": "Answers engineering questions about acme/app.",
  "permissions": "read-only",
  "access": "read",
  "integrations": {
    "slack": { "events": { "mention": true, "channel": { "match": "^help\\b" } } },
    "github": { "events": ["mention"] }
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
2. On the dashboard, the agent's Platforms tab creates its app on each platform it uses and installs it; the app's credentials go straight to the server. An app is private, installable only by its owner, or public where the platform allows it (GitHub, Linear), installable by any account. An install started on the platform signs the installer in to Coder and binds to the app's workspace when they are a member.
3. Events now reach the server, a task runs on its runner, and the reply is posted back. `coder agent run helper <event.json> --server --wait` fires one by hand; without `--server` it runs offline, platform tools off, reply printed. `--server` means `CODER_SERVER`, else the hosted service; give it a URL to pick another.

Only pushes to the agents repo's configured branch are imported, and each changed definition becomes a new version. An app created before push events existed needs the `push` event enabled once in its GitHub App settings.

### Definition

`agent.json`. The folder name is the id; the built-in id `coder` is reserved.

| Key                         | Values                                                                                                                                                                                                  | Purpose                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `description`       | Text                                                                                                                                                                                                    | App name and handle; the description is added to the prompt                                                                                                                                                                |
| `engine`, `model`, `effort` | As in `coder task run`                                                                                                                                                                                  | Engine defaults                                                                                                                                                                                                            |
| `permissions`               | `auto` (default), `workspace-write`, `read-only`                                                                                                                                                        | Sandbox mode inside the checkout, also for the tasks its [flows](../flows.md) start                                                                                                                                        |
| `integrations.<id>.events`  | Event names from the [integration](#integrations): a list, or a map of event → `true`, a flow name (repo `.coder/flows` or built-in such as `review`), or `{ "flow", "match", "permissions", "actAs" }` | A list or `true` runs the agent, a flow name runs that flow, `match` is a regex the event text must pass, `permissions` overrides the agent's for this event, `"actAs": "requester"` uses the requester's own GitHub token |
| `access`                    | `read` (Read-only) or `write` (Read-write, default)                                                                                                                                                     | What it may do on its platforms and connections; also its apps' permissions                                                                                                                                                |
| `mcp`                       | A map of MCP servers in the `.mcp.json` entry shape, as in [MCP](../mcp.md)                                                                                                                             | Servers every task of the agent attaches                                                                                                                                                                                   |

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

| Key                                        | Values             | Purpose                                                            |
| ------------------------------------------ | ------------------ | ------------------------------------------------------------------ |
| `engine`, `model`, `effort`, `permissions` | As above           | Override the definition                                            |
| `connections`                              | Connection id list | Narrow `agents.<id>.connections`; omit for all granted connections |
| `access`                                   | `read`             | Lower the definition's access to Read-only                         |
| `integrations.<id>.allowedEvents`          | Event names        | Cap the definition's events; omit to allow all it asks for         |
| `disabled`                                 | `true`             | Disable the agent and keep its other settings                      |

Unknown ids, integrations, events, and keys fail validation. Usage is read from the repo the event came from.

Disable or Enable any agent, built-in ones included, in its Settings › Manage in the dashboard. A disabled agent answers no platform events and starts no tasks in that workspace; its apps, versions, settings and past tasks stay, and other workspaces are unaffected.

## CLI

| Command                                                             | Purpose                                                                |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `coder agent list [--server [url]]`                                 | List agents, with active versions on a server                          |
| `coder agent show <id> [--server [url]]`                            | One agent in full: settings, access, integrations, events              |
| `coder agent init [id]`                                             | Scaffold an agent folder; interactive without flags                    |
| `coder agent push [id] [--server [url]]`                            | Upload one agent, or all of them, without a source repo                |
| `coder agent run <agent> <event.json> [--server [url] [--wait]]`    | Run a recorded event through an agent, on a server or offline          |
| `coder agent usage [--since 7d] [--by agent\|installation\|engine]` | Aggregate usage of this machine's tasks, or a server's with `--server` |
| `coder agent integrations <list\|show <id>>`                        | Integrations with their events and tool presets                        |
| `coder task run --agent <id> "…"`                                   | Run an agent's definition locally; flags override it                   |

## Integrations

An integration gives an agent two things:

1. **Chat.** The agent's own app on the platform. Its events start tasks, and the reply goes back to the same thread. Linked workspace members can address an agent, and so can anyone the platform lets write there (on GitHub, write access to the repository); they get the workspace's connections only.
2. **Platform tools.** Actions beyond replying, through each platform's MCP server, one per installation of the agent's apps. They run outside the agent's sandbox, with a token for that installation in the agent's access mode; the agent can read that token during its turn. Read-only exposes only tools the platform server marks read-only; Read-write exposes all its tools. The prompt lists the servers; the engine loads a server's tools when it needs them. Replies, reactions and history work in both modes.

| Platform | App                                                                                                                         | Events                                        | Tools                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| GitHub   | A [GitHub App](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) per agent      | `mention`, `pull_request`, `issue`, `comment` | GitHub's [MCP server](https://github.com/github/github-mcp-server); `read` runs it read-only                  |
| Slack    | A [Slack app](https://api.slack.com/reference/manifests) per agent                                                          | `mention`, `dm`, `channel`, `command`         | [Slack MCP server](https://github.com/korotovsky/slack-mcp-server), pinned to v1.3.0 with SHA256 verification |
| Linear   | Your [Linear OAuth app](https://linear.app/developers/agents), with webhooks to `<PUBLIC_URL>/hooks/linear?app=<client id>` | `mention`: an agent session                   | [Official Linear MCP server](https://linear.app/docs/mcp) at `https://mcp.linear.app/mcp`                     |

On Slack, `dm` takes every message in direct and group DMs with the agent, and `channel` every message in channels it is in, up to Slack's 30,000 events per workspace per app per hour. A Slack app's Home tab shows the agent and how to use it, and links to this server's tasks and agents unfurl into a short card.

When an agent's app needs other events, permissions or settings, publishing the agent brings it up to date. Coder updates a Slack app itself and lists the changes to make on GitHub and Linear, and **Update on <platform>** in the handle's menu on the Platforms tab does the same later.

`coder agent integrations show <id>` lists each event and each preset's exact tools or scopes. A host turns platforms off with `SERVER_INTEGRATIONS` ([Self-hosting](../self-host.md)).

Need another integration or a missing event or tool? [Open an issue](https://github.com/muzam1l/coder/issues).
