# MCP

Give tasks tools of your own: an MCP server is saved once under `mcp` in `.coder/config.json`, then attached to a task by name. Nothing attaches unless asked, so the default run stays lean.

```sh
coder mcp add docs -- npx -y docs-mcp                       # stdio server: the command after --
coder mcp add linear --url https://mcp.linear.app/mcp        # remote server; OAuth login happens in the engine on first use
coder run --mcp docs,linear "why do uploads fail after a rename?"
```

## Adding servers

| Command                                    | Does                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `coder mcp add <name> -- <command> [args]` | Stdio server. `--env K=V,...` sets its environment                                           |
| `coder mcp add <name> --url <url>`         | Remote server. `--header K=V,...` adds request headers, `--transport sse` for legacy servers |
| `coder mcp add-json <name> '<entry>'`      | Paste an entry from any `.mcp.json`, Cursor `mcp.json`, or a vendor README as is             |
| `coder mcp list`, `coder mcp rm <name>`    | List and remove                                                                              |

`add` takes `--tools a,b` to cap what the agent may call; `add-json` accepts a `tools` array in the entry. `add`, `add-json` and `rm` take `--user` to write `~/.coder` instead of the repo. Repo and user maps merge, repo wins on a name.

## Config shape

The entries are the `.mcp.json` convention shared by Claude Code, Cursor, Windsurf and Codex, so anything written for them drops in:

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

`${VAR}` and `${VAR:-default}` in any value expand from the environment when the server starts, so tokens never sit in the file.

## Attaching to a task

`--mcp` on `coder task run` (and `coder run`) takes names, `all`, or an inline JSON array of entries with a `name` field for one-off servers:

```sh
coder run --mcp docs "..."
coder run --mcp all "..."
coder run --mcp '[{"name":"tmp","command":"node","args":["server.js"]}]' "..."
```

Claude gets the servers through `--mcp-config` with the allowlist as `mcp__<name>__<tool>`; Codex gets them as `mcp_servers.<name>` overrides with `enabled_tools`. Agents attach their integration tools the same way, so an agent never needs an entry here.
