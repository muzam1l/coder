# Bring your own model

Point Coder at any OpenAI-compatible URL, like Ollama or llama.cpp on your laptop, a vLLM GPU box, OpenRouter, etc., and dispatch subagents to it like any built-in model. No login, no extra setup: permissions, steering, and fallback just work.

## Connect a model

```bash
# local Ollama model, no key
coder setup-model qwen --base-url http://localhost:11434/v1 --model qwen2.5-coder:32b

# third-party provider via OpenRouter
coder setup-model kimi --base-url https://openrouter.ai/api/v1 --model moonshotai/kimi-k2 --env-key OPENROUTER_API_KEY
```

`setup-model` saves the entry, probes the endpoint, and reports anything missing (unreachable URL, unset key env var, no codex). Flags:

| Flag | Meaning |
| --- | --- |
| `--base-url <url>` | OpenAI-compatible API base (e.g. `http://localhost:11434/v1`) |
| `--model <id>` | the provider's model id (e.g. `qwen2.5-coder:32b`) |
| `--env-key <VAR>` | env var holding the API key; omit for keyless local endpoints |
| `--remove <name>` | delete a configured model |
| `--workspace` | write to `<repo>/coder.config.json` instead of the user file |

## Use it

Anywhere a model name goes:

```bash
coder run --model qwen "explain this repo"        # per task
coder config set agents.codex.model qwen          # as the default
coder setup-model                                 # list models + probe their endpoints
```

## Config shape

`setup-model` writes the `models` section of the [config](../README.md#configuration):

```json
{
  "models": {
    "qwen": { "baseUrl": "http://localhost:11434/v1", "model": "qwen2.5-coder:32b", "envKey": "MY_KEY" }
  }
}
```
