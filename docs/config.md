# Configuration

The Coder configuration reference. Machine defaults live in `~/.coder/config.json`; `.coder/config.json` in a repo overrides them per project. Merge order, later wins:

1. Built-in defaults
2. `~/.coder/config.json`
3. `<repo>/.coder/config.json`
4. CLI flags on the dispatch itself (`--model`, `--effort`, `--access`)

Read and write values in the dashboard under **# Settings → (Engines)** and **(Models)**, or from the CLI (`--workspace` targets the repo file instead of the user file):

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
    "codex": { "model": "sol", "effort": "high", "network": true },
    "claude": { "model": "opus", "effort": "medium" },
    "custom": { "model": "qwen" }
  },
  "models": {
    "qwen": { "baseUrl": "http://localhost:11434/v1", "model": "qwen2.5-coder:32b" },
    "fast": { "provider": "codex", "model": "gpt-6-luna" },
    "big": { "provider": "claude", "model": "opus", "effort": "high" },
    "astra": { "disabled": true }
  },
  "approvals": {
    "allowedNetworkHosts": ["localhost", "127.0.0.1", "registry.npmjs.org"]
  },
  "agents": {
    "review": false,
    "helper": {
      "access": "read-only"
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

A task's access is `auto` or `read-only` (`--access`, or **# Tasks → [New task]**), the same on every engine: `auto` lets the engine's own reviewer decide actions outside the sandbox (see [approvals](#approvals)), `read-only` changes nothing and uses only read-only tools. A read-only agent or parent task makes its tasks read-only; `engines.codex.network` overrides network access for every mode when set.

A task reaches only its workspace unless you give it more. Pass `--add-dir <dir>` to `coder run` once for each sibling repo or shared folder the task needs. Relative paths resolve against the workspace and each one must already exist. Read-only tasks can read these directories but never write them, while auto tasks can write them just like the workspace. Claude receives them as `--add-dir` and `permissions.additionalDirectories`, so its OS sandbox follows the same rules. Codex already reads everywhere in read-only, and in auto it receives them as extra writable roots in the turn's sandbox policy. The directories are saved on the task, `coder result` lists them, and steering keeps them.

## `models`

One namespace for every model you can name as `--model`, keyed by that name. An entry's shape decides what it is:

| Shape                                                   | Meaning                                                                                                | Managed by                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `{ "baseUrl", "model", "envKey"?, "wireApi"? }`         | custom OpenAI-compatible endpoint (the `custom` engine)                                                | `coder model add/update/remove` |
| `{ "provider": "codex"\|"claude", "model", "effort"? }` | alias onto a built-in engine                                                                           | `coder model alias/unalias`     |
| `{ "disabled": true }`                                  | bare toggle turning off any model name (built-in, entry from another config layer, or raw engine slug) | `coder model disable/enable`    |

Every shape also accepts `"disabled": true` to park the entry without deleting it. An entry named after a built-in alias (e.g. `luna`) shadows it. See [Models](models.md).

## `approvals`

| Key                   | Meaning                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `allowedNetworkHosts` | Hosts (and their subdomains) tasks reach without review. Default `[]`. Also in the dashboard, **# Settings → (Engines)**. |

How tasks ask for more: [Access and approvals](access.md).

## `agents`

Per-agent usage: enable, override, scope. Reference and examples in [Agents](agents/index.md#usage).

## `mcp`

Servers tasks can attach with `--mcp <name>`, in the `.mcp.json` entry shape. Reference and CLI in [MCP](mcp.md).
