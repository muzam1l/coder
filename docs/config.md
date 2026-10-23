---
description: Every setting in ~/.coder/config.json and a repository's .coder/config.json.
---

# Configuration

`~/.coder/config.json` holds a machine's settings, and `.coder/config.json` in a repo overrides them for that repo. Later wins:

1. Built-in defaults
2. `~/.coder/config.json`
3. `<repo>/.coder/config.json`
4. Flags on the task (`--model`, `--access`)

On a Coder server, the workspace's settings take the place of the user file, and a repo can only shorten `chain` or set its own `reviewModel`. The dashboard edits them under **# Settings**; the CLI with `coder config` (`--workspace` writes the repo file):

```bash
coder config list
coder config set chain '["codex/sol", "claude/opus"]'
coder config migrate          # rewrite an older file in the current shape
```

## Full shape

```json
{
  "$schema": "https://coder.wular.ai/schema/config.v1.json",
  "version": 1,
  "chain": ["codex/sol", "claude/opus", "qwen"],
  "reviewModel": "codex/astra",
  "models": {
    "claude": "claude/sonnet/high",
    "fast": "codex/luna/low",
    "qwen": { "baseUrl": "http://localhost:11434/v1", "model": "qwen2.5-coder:32b" },
    "astra": false
  },
  "agents": { "coder": { "model": "sol", "access": "read-only" }, "helper": false },
  "mcp": { "docs": { "command": "npx", "args": ["-y", "docs-mcp"], "tools": ["search"] } },
  "network": { "allowedHosts": ["localhost", "registry.npmjs.org"], "readOnlyTasks": true }
}
```

Every value that names a model is a [model spec](models.md#pick-a-model): `sol`, `sol/low`, `claude/opus` or `codex/gpt-6.1-sol/high`. A spec without an effort runs at `medium`.

| Key | Meaning | Default |
|---|---|---|
| `version` | The config's format; Coder writes it | `1` |
| `chain` | Models in order. The first runs a task with no model of its own; the next ones take over when a model can't start (missing CLI, sign-in, quota, rate limit). A task's or agent's model goes first and the rest follow. | `["codex/sol", "claude/opus"]` |
| `reviewModel` | The model `coder review` and the `review` tool use | `"codex/astra"` |
| `models` | Names a spec can use: an alias (a spec string), `false` to turn a name off, or an endpoint (below) | built-in aliases |
| `agents` | How this repo runs each agent: [Usage](agents/index.md#usage) | |
| `mcp` | Servers a task attaches with `--mcp`: [Connections](connections.md#mcp-servers-in-config) | |
| `network.allowedHosts` | Hosts, with their subdomains, that auto tasks reach without review ([Approvals](approvals.md)) | `[]` |
| `network.readOnlyTasks` | Read-only tasks also reach `allowedHosts`, on every engine | `false` |

## `models`

- **Alias:** `"fast": "codex/luna/low"`. Built-in aliases are `luna`, `sol`, `astra`, `sonnet`, `opus`, `fable`, and the engine names `codex` (sol) and `claude` (opus). An alias of the same name overrides one, so `"claude": "claude/sonnet/high"` makes `--model claude` run sonnet at high. `coder model alias` and `unalias`.
- **Off:** `"astra": false`. The name can't be picked or fallen back to. `coder model disable` and `enable`.
- **Endpoint:** `{ "baseUrl", "model", "envKey"?, "wireApi"?, "contextWindow"?, "disabled"? }`, an OpenAI-compatible model where `model` is the provider's id. `coder model add`, `update` and `remove`; [Models](models.md#connect-a-model).

## Versions

An older file (no `version`, or a lower one) is brought up to date when it loads. The user file is rewritten, with the old one kept as `config.json.bak`. A repo file is updated in memory only, since teammates may run an older Coder; `coder config migrate --workspace` rewrites it. A file from a newer Coder is refused with the upgrade command.

## Extra directories

A task reaches only its workspace unless given more: `--add-dir <dir>` on `coder task run`, once per folder. Each one must exist. Read-only tasks read them, auto tasks also write them, and steering keeps them.
