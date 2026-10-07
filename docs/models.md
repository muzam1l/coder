# Models

Manage every model Coder can dispatch to. That means the built-in Codex and Claude aliases, and your own - any OpenAI-compatible URL, like Ollama or llama.cpp on your laptop, a vLLM GPU box, OpenRouter, etc. Custom models work like any built-in: no login, and permissions, steering, and fallback just work.

## Connect a model

```bash
# local Ollama model, no key
coder model add qwen --base-url http://localhost:11434/v1 --model qwen2.5-coder:32b

# third-party provider via OpenRouter, key read from the environment
coder model add kimi --base-url https://openrouter.ai/api/v1 --env-key OPENROUTER_API_KEY --model moonshotai/kimi-k2
```

`model add` saves the entry, probes the endpoint, and reports anything missing (unreachable URL, unset key env var, no codex). Change one later with `coder model update <name>`, drop it with `coder model remove <name>`. Flags:

| Flag               | Meaning                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `--base-url <url>` | OpenAI-compatible API base (e.g. `http://localhost:11434/v1`)                            |
| `--model <id>`     | the provider's model id (e.g. `qwen2.5-coder:32b`)                                       |
| `--env-key <VAR>`  | env var holding the API key; omit for keyless local endpoints                            |
| `--workspace`      | write to `<repo>/.coder/config.json` instead of the user file                            |

## Use it

Anywhere a model name goes; together they form the `custom` engine:

```bash
coder run --model qwen "explain this repo"        # per task
coder run --engine custom "explain this repo"      # the custom engine (its default model, or the only one)
coder config set engines.custom.model qwen         # default model for --engine custom
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
like `gpt-6-astra` - without removing its configuration, then re-enable it
when needed; requests for a disabled model fail at dispatch:

```bash
coder model disable astra
coder model enable astra
```

Create an alias for an engine spec with `coder model alias fast codex:luna`
(effort can ride along: `coder model alias big claude:opus:high`); remove it
with `coder model unalias fast`. Aliases may reuse a built-in name, so
`coder model alias luna codex:gpt-x` intentionally overrides the built-in
`luna`, and `model list` shows the override in its place.

The built-ins:

| Alias    | Model                 | Use it for                       | Needs          |
| -------- | --------------------- | -------------------------------- | -------------- |
| `luna`   | `gpt-6-luna` (codex)  | mechanical work                  | codex 0.156.1  |
| `sol`    | `gpt-6.1-sol` (codex) | the default                      | codex 0.159.1  |
| `astra`  | `gpt-6-astra` (codex) | the hardest work; costs the most | codex 0.154.0  |
| `sonnet` | `sonnet` (claude)     | mechanical work                  | claude 2.1.197 |
| `opus`   | `opus` (claude)       | the default                      | claude 2.1.280 |
| `fable`  | `fable` (claude)      | the hardest work; costs the most | claude 2.1.257 |

A task on an older CLI still runs, with a warning to run `codex update` or
`claude update`.

Claude aliases pass through to the claude CLI, which resolves them to its
current model (`opus` is Claude Opus 5.5 today). Any full model id, such as
`gpt-5.6-sol` or `claude-sonnet-5`, also works as a pass-through.

## Config shape

Every model command writes the one `models` section of the
[config](config.md); the entry's shape says what it is (endpoint,
engine alias, or a bare disable toggle for any model name):

```json
{
  "models": {
    "qwen": {
      "baseUrl": "http://localhost:11434/v1",
      "model": "qwen2.5-coder:32b",
      "envKey": "MY_KEY"
    },
    "fast": { "provider": "codex", "model": "gpt-6-luna" },
    "big": { "provider": "claude", "model": "opus", "effort": "high" },
    "astra": { "disabled": true }
  }
}
```
