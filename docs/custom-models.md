# Bring your own model

Point Coder at any OpenAI-compatible URL, like Ollama or llama.cpp on your laptop, a vLLM GPU box, OpenRouter, etc., and dispatch subagents to it like any built-in model. No login, no extra setup: permissions, steering, and fallback just work.

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

## Config shape

`coder model add` writes the `models` section of the [config](../README.md#configuration):

```json
{
  "models": {
    "qwen": { "baseUrl": "http://localhost:11434/v1", "model": "qwen2.5-coder:32b", "envKey": "MY_KEY" }
  }
}
```
