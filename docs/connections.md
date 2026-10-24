---
description: Platform and MCP server connections, workspace and personal scopes, and MCP config.
---

# Connections

A connection gives tasks tools: a platform (GitHub, Slack, Linear and the other native integrations) or an MCP server. Keys that tasks read as environment variables are task secrets, under **# Settings → (Credentials)**, not connections.

## Workspace or personal

Every connection has one scope. Its token decides whose name its actions carry; the platform sets that, not Coder.
- **Workspace:** the workspace's own identity. On a platform, the agent's installed app; on an MCP server, the account an admin connected it with. Every turn gets it.
- **Personal:** one member's own account. Only that member's turns get it, and its first use in a task asks them to approve.

For workspace Acme, agent Coder, and member Ada:

| | Workspace | Ada's personal |
|---|---|---|
| Slack | `slack`: Coder's bot. Reads the channels it's in, can't search, posts as Coder. | `slack-user`: Ada's account. Searches everything Ada can see; acts as Ada. |
| GitHub | `github-acme`: the app's installation on `acme`. Comments, commits and pushes as `coder-cloud-ai[bot]`. | `github-user`: Ada's sign-in. Once Ada approves the act-as request, the turn commits and pushes as Ada, and a pull request lists Ada as its author. |
| Linear | `linear-acme`: the app. "My issues" are the app's. | `linear-user`: Ada's sign-in. "My issues" are hers. |
| Notion (MCP) | `notion`: a Notion MCP token from Acme's workspace owner. | `notion-user`: Ada's own Notion sign-in. |

- A platform's workspace side is the installed app, managed under **# Agents → *agent* → (Platforms)**. Members add only personal platform connections.
- An MCP server can be workspace, personal, or both. An admin adds a workspace one; each member adds their own.
- Another member's turns get the workspace servers and their own, never Ada's.
- Every member sees every connection's name, scope, owner and status, never its secret.

## In a task

Each turn's tool search lists the servers that turn can use, each with its scope, and each call names its server. Workspace is the default. A personal server is for acting as the person, or for what only their account reaches, such as Slack search. Without one, the agent replies with that person's `connection/add` link. A message from anyone else during a turn ends the personal access until the owner's next turn.

The agent's Connections setting and `coder task run --connections` narrow the list. Access is Auto (default) or Read-only; the strictest of the connection's, the agent's and the task's applies, and Read-only keeps only the tools a server marks read-only.

## Statuses

- `connected`: works.
- `needs-auth`: its owner signs in or reconnects in the dashboard; the result carries the link.
- `disabled`: exists, but this agent isn't granted it.
- `failed`: the server didn't start this turn.

## Adding one

- **Thread:** the agent replies with a filled-in link.
- **Dashboard:** **# Settings → (Connections) → [Add connection]**.
- **CLI:**

```sh
coder connection add github --server                                              # a member's own GitHub
coder connection add notion --url https://mcp.notion.com/mcp --server              # workspace MCP server (admins)
coder connection add notion --personal --url https://mcp.notion.com/mcp --server   # a member's own
coder connection add docs -- npx -y docs-mcp                                      # stdio server: the command after --
```

- A remote server's sign-in is detected: OAuth (needs `--server`), open access, or a key. A key is read from stdin or a prompt, or with `--key`, into `--header` (default `Authorization`) or, for a stdio server, `--env`. `--auth` overrides the detection.
- `--access read-only` keeps only read-only tools; a read-only stdio server needs `--tools a,b`.

## MCP servers in config

An `mcp` entry in `.coder/config.json` or `~/.coder/config.json` is a server a task attaches by name with `--mcp`; nothing attaches unless asked. Entries use the `.mcp.json` shape of Claude Code, Cursor and Codex, plus `tools` and `description`. The repo's entry wins on a name. Coder itself as an MCP server in a host: [In your local harness](../README.md#in-your-local-harness).

```json
{
  "mcp": {
    "docs": { "command": "npx", "args": ["-y", "docs-mcp"], "tools": ["search"] },
    "sentry": { "command": "npx", "args": ["-y", "@sentry/mcp-server"], "env": { "SENTRY_TOKEN": "${SENTRY_TOKEN}" } }
  }
}
```

| Key | Purpose |
|---|---|
| `command`, `args`, `env` | Stdio server to start |
| `url`, `headers` | Remote server, streamable HTTP |
| `tools` | Allowed tool names; omit for all |
| `description` | What the server is for |

- A repository's servers need local approval: `coder connection approve <name>`.
- `${VAR}` and `${VAR:-default}` expand from the environment, except in a repository remote entry's URL and headers; use a connection for credentials.
- `--mcp` takes names, `all` (also the engine's own MCP servers), or inline JSON: `coder run --mcp '[{"name":"tmp","command":"node","args":["server.js"]}]' "…"`.
