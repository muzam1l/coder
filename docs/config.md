# Configuration

The Coder configuration reference. Machine defaults live in `~/.coder/config.json`; a `coder.config.json` at a repo root overrides per project. Merge order, later wins:

1. Built-in defaults
2. `~/.coder/config.json`
3. `<repo>/coder.config.json`
4. CLI flags on the dispatch itself (`--agent`, `--model`, `--effort`, `--permissions`)

Read and write values from the CLI (`--workspace` targets the repo file instead of the user file):

```bash
coder config get [key]
coder config set chain '["codex", "claude", "custom"]'
coder config set agents.codex.model terra
```

## Full shape

```json
{
  "chain": ["codex", "claude", "custom"],
  "agents": {
    "codex": { "model": "terra", "effort": "high", "permissions": "auto" },
    "claude": { "model": "opus", "effort": "medium", "permissions": "auto" },
    "custom": { "model": "qwen" }
  },
  "models": {
    "qwen": { "baseUrl": "http://localhost:11434/v1", "model": "qwen2.5-coder:32b" },
    "fast": { "provider": "codex", "model": "gpt-5.3-codex-spark" },
    "big": { "provider": "claude", "model": "opus", "effort": "high" },
    "luna": { "disabled": true }
  }
}
```

## `chain`

Fallback order. When an agent can't start (missing binary, auth, quota), the task automatically retries on the next entry. Default `["codex", "claude"]`.

## `agents`

Per-agent defaults, used when a dispatch doesn't override them:

| Key | Values |
| --- | --- |
| `model` | codex: `spark`, `luna`, `terra`, `sol` · claude: `opus`, `sonnet`, `fable` · custom: any name from `models` |
| `effort` | `low`, `medium`, `high` |
| `permissions` | `read-only`, `workspace-write`, `auto` |

Permission modes are one surface across all engines: read-only can't modify anything, workspace-write stays inside the repo, auto adds policy-answered escalations.

## `models`

One namespace for every model you can name as `--model`, keyed by that name. An entry's shape decides what it is:

| Shape | Meaning | Managed by |
| --- | --- | --- |
| `{ "baseUrl", "model", "envKey"?, "wireApi"? }` | custom OpenAI-compatible endpoint (the `custom` agent) | `coder model add/update/remove` |
| `{ "provider": "codex"\|"claude", "model", "effort"? }` | alias onto a built-in engine | `coder model alias/unalias` |
| `{ "disabled": true }` | bare toggle turning off any model name (built-in, entry from another config layer, or raw engine slug) | `coder model disable/enable` |

Every shape also accepts `"disabled": true` to park the entry without deleting it. An entry named after a built-in alias (e.g. `spark`) shadows it. See [Models](models.md).

---

Config files are validated strictly: an unknown key or bad value fails with a pointed error instead of being silently ignored.
