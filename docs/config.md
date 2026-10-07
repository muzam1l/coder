# Configuration

The Coder configuration reference. Machine defaults live in `~/.coder/config.json`; `.coder/config.json` in a repo overrides them per project. Merge order, later wins:

1. Built-in defaults
2. `~/.coder/config.json`
3. `<repo>/.coder/config.json`
4. CLI flags on the dispatch itself (`--engine`, `--model`, `--effort`, `--permissions`)

Read and write values from the CLI (`--workspace` targets the repo file instead of the user file):

```bash
coder config list
coder config get <key>
coder config set chain '["codex", "claude", "custom"]'
coder config set engines.codex.model sol
```

## Full shape

```json
{
  "chain": ["codex", "claude", "custom"],
  "engines": {
    "codex": { "model": "sol", "effort": "high", "permissions": "auto", "network": true },
    "claude": { "model": "opus", "effort": "medium", "permissions": "auto" },
    "custom": { "model": "qwen" }
  },
  "models": {
    "qwen": { "baseUrl": "http://localhost:11434/v1", "model": "qwen2.5-coder:32b" },
    "fast": { "provider": "codex", "model": "gpt-6-luna" },
    "big": { "provider": "claude", "model": "opus", "effort": "high" },
    "astra": { "disabled": true }
  },
  "approvals": {
    "escalationTimeoutMs": 120000,
    "allowedNetworkHosts": ["localhost", "127.0.0.1", "registry.npmjs.org"]
  },
  "agents": {
    "review": false,
    "helper": {
      "permissions": "read-only",
      "integrations": {
        "github": { "allowedTools": "comment" }
      }
    }
  },
  "mcp": {
    "docs": { "command": "npx", "args": ["-y", "docs-mcp"], "tools": ["search"] }
  }
}
```

## `chain`

Fallback order. When an engine can't start (missing binary, auth, quota), the task automatically retries on the next entry. Default `["codex", "claude"]`.

## `engines`

Per-engine defaults, used when a dispatch doesn't override them:

| Key           | Values                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`       | codex: `luna`, `sol` (default), `astra` · claude: `sonnet`, `opus` (default), `fable` · custom: any name from `models` · or any full model id |
| `effort`      | `low`, `medium`, `high`                                                                                                                       |
| `permissions` | `read-only`, `workspace-write`, `auto`                                                                                                        |

Permission modes are one surface across all engines: read-only can't modify anything, workspace-write stays inside the repo, and auto enables Codex network access plus policy-answered escalations; `engines.codex.network` overrides network access for every mode when set.

A task reaches only its workspace unless you give it more. Pass `--add-dir <dir>` to `coder run` once for each sibling repo or shared folder the task needs. Relative paths resolve against the workspace and each one must already exist. Read-only tasks can read these directories but never write them, while workspace-write and auto tasks can write them just like the workspace. Claude receives them as `--add-dir` and `permissions.additionalDirectories`, so its OS sandbox follows the same rules. Codex already reads everywhere in read-only, and in the other modes it receives them as extra writable roots in the turn's sandbox policy. The directories are saved on the task, `coder result` lists them, and both `--resume` and steering keep them.

## `models`

One namespace for every model you can name as `--model`, keyed by that name. An entry's shape decides what it is:

| Shape                                                   | Meaning                                                                                                | Managed by                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `{ "baseUrl", "model", "envKey"?, "wireApi"? }`         | custom OpenAI-compatible endpoint (the `custom` engine)                                                | `coder model add/update/remove` |
| `{ "provider": "codex"\|"claude", "model", "effort"? }` | alias onto a built-in engine                                                                           | `coder model alias/unalias`     |
| `{ "disabled": true }`                                  | bare toggle turning off any model name (built-in, entry from another config layer, or raw engine slug) | `coder model disable/enable`    |

Every shape also accepts `"disabled": true` to park the entry without deleting it. An entry named after a built-in alias (e.g. `luna`) shadows it. See [Models](models.md).

## `approvals`

Tunes the `auto` permission mode; ignored by `read-only` and `workspace-write`.

| Key                   | Meaning                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `escalationTimeoutMs` | How long an escalated approval waits for an answer before auto-denying and letting the task move on. Default `120000`. |
| `allowedNetworkHosts` | Hosts (and their subdomains) coders may reach without an approval when network sandboxing is active. Default `[]`.     |

`allowedNetworkHosts` is pre-allowed in the Claude sandbox and auto-accepted by the Codex approval policy when `engines.codex.network` is `false`. A bare hostname covers its subdomains; anything else escalates as usual. Listing `localhost`, `127.0.0.1` or `::1` also lets sandboxed Claude commands serve on local ports (macOS), so a task can run a dev server.

Allowlist only hosts you trust: the check is by name, not by the address the name resolves to.

## `agents`

Per-agent usage: enable, override, scope. Reference and examples in [Agents](agents/index.md#usage).

## `mcp`

Servers tasks can attach with `--mcp <name>`, in the `.mcp.json` entry shape. Reference and CLI in [MCP](mcp.md).
