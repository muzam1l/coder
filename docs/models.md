---
description: Built-in Claude and Codex models, custom endpoints, aliases, the chain, and turning models off.
---

# Models

Every model a task can run: the built-in Codex and Claude models, aliases, and custom models at any OpenAI-compatible URL, such as Ollama or llama.cpp on a laptop, a vLLM box or OpenRouter. A custom model works like a built-in one: no login, and permissions, steering and fallback all apply.

## Pick a model

`--model`, an agent's `model`, `chain` and `reviewModel` each take one spec:
- `<name>`: a built-in, an alias, a custom model, or an engine (`codex`, `claude`) for its model.
- `<name>/<effort>`: `sol/low`, `fast/high`.
- `<engine>/<model>`, `<engine>/<model>/<effort>`: `claude/opus`, `codex/gpt-6.1-sol/high`.

Effort is `low`, `medium` or `high`; without one, `medium`, unless the alias sets its own. On a custom chat endpoint it's sent as OpenRouter's `reasoning.effort`.

## The chain

`chain` lists models in order, default `["codex/sol", "claude/opus"]`. A task runs its own model (from `--model` or its agent) else the first entry. When a model can't start (missing CLI, sign-in, quota, rate limit), the next one runs; a turn that already did work fails with the reason instead. Within one model, the asker's own subscription and key come before the workspace's. **# Settings → (Models)** shows the chain and what each entry runs on for the viewer.

```bash
coder config set chain '["codex/sol", "claude/opus", "qwen"]'
```

## Built-ins and aliases

| Name | Runs | Needs |
|---|---|---|
| `luna` | `codex/gpt-6-luna` | codex 0.156.1 |
| `sol` | `codex/gpt-6.1-sol` | codex 0.159.1 |
| `astra` | `codex/gpt-6-astra`, the review default | codex 0.154.0 |
| `sonnet` | `claude/sonnet` | claude 2.1.197 |
| `opus` | `claude/opus` | claude 2.1.280 |
| `fable` | `claude/fable` | claude 2.1.257 |
| `codex`, `claude` | `codex/sol`, `claude/opus` | |

A task on an older CLI still runs, with a warning to update it. Claude names pass to the claude CLI, which resolves them (`opus` is Claude Opus 5.5 today); any full model id also works.

An alias names a spec, and one with a built-in's name overrides it:

```bash
coder model alias fast codex/luna/low
coder model alias claude claude/sonnet/high   # --model claude now runs sonnet at high
coder model unalias claude                    # back to the built-in
coder model disable astra                     # can't be picked or fallen back to
```

## Connect a model

Under **# Settings → (Models)** or with `coder model add`:

```bash
coder model add qwen --base-url http://localhost:11434/v1 --model qwen2.5-coder:32b
coder model add kimi --base-url https://openrouter.ai/api/v1 --env-key OPENROUTER_API_KEY --model moonshotai/kimi-k2
```

`model add` saves the entry, checks the endpoint, and reports what's missing (unreachable URL, unset key variable, no codex). `coder model update <name>` changes one, `coder model remove <name>` drops it, `coder model list` lists every name and checks endpoints.

| Flag | Meaning |
|---|---|
| `--base-url <url>` | OpenAI-compatible API base |
| `--model <id>` | The provider's model id |
| `--env-key <VAR>` | The variable holding the API key; omit for keyless local endpoints |
| `--context-window <tokens>` | Filled in when the provider reports it; Codex compacts at 90% |
| `--workspace` | Write the repo's `.coder/config.json` instead of the user file |

Entries live in the `models` section of the [config](config.md#models).
