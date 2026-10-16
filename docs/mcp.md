# MCP

Give tasks tools of your own: an MCP server is a [connection](agents/index.md#connections), or an entry under `mcp` in a config file you edit, attached to a task by name. Nothing from a config file attaches unless asked, so the default run stays lean. `--mcp all` also loads your engine's own MCP servers and connectors.

```sh
coder connection add docs --access write -- npx -y docs-mcp           # stdio server: the command after --
coder connection add linear --url https://mcp.linear.app/mcp --server  # remote server; signs in with OAuth
coder connection approve docs                                         # approve a repository server locally
coder run --mcp docs "why do uploads fail after a rename?"
```

For a remote URL, Coder detects OAuth, open access or a required key; OAuth needs `--server`, and a required key is read from stdin or a prompt. `--key` reads a server's key directly; it goes in `--header` (default `Authorization`) or, for a stdio server, `--env`, and `--auth` overrides detection. Access defaults to Read-only; `--access write` keeps every tool, and a read-only stdio server needs `--tools a,b`.

## Config shape

Entries in `.coder/config.json`, `~/.coder/config.json` and an agent's `agent.json` use the `.mcp.json` convention shared by Claude Code, Cursor, Windsurf and Codex, so anything written for them drops in. Repo and user maps merge, repo wins on a name:

```json
{
  "mcp": {
    "docs": { "command": "npx", "args": ["-y", "docs-mcp"], "tools": ["search"] },
    "sentry": {
      "command": "npx",
      "args": ["-y", "@sentry/mcp-server"],
      "env": { "SENTRY_TOKEN": "${SENTRY_TOKEN}" }
    },
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${GH_TOKEN}" }
    }
  }
}
```

| Key                      | Purpose                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `command`, `args`, `env` | Stdio server to spawn                                               |
| `url`, `headers`, `type` | Remote server; `type` is `http` (streamable HTTP, default) or `sse` |
| `tools`                  | Allowlist of tool names; omit for every tool the server offers      |
| `description`            | What the server is for                                              |

Repository servers need local approval with `coder connection approve <name>`; `coder connection list` shows which are approved. `${VAR}` and `${VAR:-default}` expand from the environment, except in a repository remote entry's URL and headers, where they stay literal; use a connection for credentials.

## Attaching to a task

`--mcp` on `coder task run` (and `coder run`) takes names, `all`, or an inline JSON array of entries with a `name` field for one-off servers:

```sh
coder run --mcp docs "..."
coder run --mcp all "..."
coder run --mcp '[{"name":"tmp","command":"node","args":["server.js"]}]' "..."
```

Claude gets the servers through `--mcp-config` with the allowlist as `mcp__<name>__<tool>`; Codex gets them as `mcp_servers.<name>` overrides with `enabled_tools`. Agents attach their integration tools the same way, so an agent never needs an entry here.
