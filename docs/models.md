# Models

Manage every model Coder can dispatch to. That means the built-in Codex and Claude aliases, and your own - any OpenAI-compatible URL, like Ollama or llama.cpp on your laptop, a vLLM GPU box, OpenRouter, etc. Custom models work like any built-in: no login, and permissions, steering, and fallback just work.

## Connect a model

```bash
# local Ollama model, no key
coder model add qwen --base-url http://localhost:11434/v1 --model qwen2.5-coder:32b

# third-party provider via OpenRouter
coder model add kimi --base-url https://openrouter.ai/api/v1 --model moonshotai/kimi-k2 --env-key OPENROUTER_API_KEY
```

`model add` saves the entry, probes the endpoint, and reports anything missing (unreachable URL, unset key env var, no codex). Change one later with `coder model update <name>`, drop it with `coder model remove <name>`. Flags:

| Flag | Meaning |
| --- | --- |
| `--base-url <url>` | OpenAI-compatible API base (e.g. `http://localhost:11434/v1`) |
| `--model <id>` | the provider's model id (e.g. `qwen2.5-coder:32b`) |
| `--env-key <VAR>` | env var holding the API key; omit for keyless local endpoints |
| `--workspace` | write to `<repo>/coder.config.json` instead of the user file |

## Use it

Anywhere a model name goes; together they form the `custom` agent:

```bash
coder run --model qwen "explain this repo"        # per task
coder run --agent custom "explain this repo"      # the custom agent (its default model, or the only one)
coder config set agents.custom.model qwen         # default model for --agent custom
coder model list                                  # list models + probe their endpoints
```

Add `custom` to the fallback chain to make your models a fallback tier, e.g. a local model that takes over when the hosted engines are out of quota:

```bash
coder config set chain '["codex", "claude", "custom"]'
```

## Built-ins, aliases, disabling

Built-ins are just pre-seeded aliases tied to an engine, so `coder model list`
shows them and your own aliases together, grouped per engine. Disable
any model name - a built-in, a custom model, an alias, or a raw engine slug
like `gpt-5.6-terra` - without removing its configuration, then re-enable it
when needed; requests for a disabled model fail at dispatch:

```bash
coder model disable terra
coder model enable terra
```

Create an alias for an agent spec with `coder model alias fast codex:spark`
(effort can ride along: `coder model alias big claude:opus:high`); remove it
with `coder model unalias fast`. Aliases may reuse a built-in name, so
`coder model alias spark codex:gpt-x` intentionally overrides the built-in
`spark`, and `model list` shows the override in its place.

## Config shape

Every model command writes the one `models` section of the
[config](config.md); the entry's shape says what it is (endpoint,
engine alias, or a bare disable toggle for any model name):

```json
{
  "models": {
    "qwen": { "baseUrl": "http://localhost:11434/v1", "model": "qwen2.5-coder:32b", "envKey": "MY_KEY" },
    "fast": { "provider": "codex", "model": "gpt-5.3-codex-spark" },
    "big": { "provider": "claude", "model": "opus", "effort": "high" },
    "terra": { "disabled": true }
  }
}
```
