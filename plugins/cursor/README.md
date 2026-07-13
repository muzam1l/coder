<div align="center">

# Coder

### Delegate the coding. Keep your context.

</div>

One runtime that hands your coding tasks to the best engine available and lets you steer, inspect, or stop any task while it works.

Plugs into Claude Code or Codex to enable the harness with Coder instances.

## Why Coder

- **A clean main thread.** Installed in Claude Code or Codex, dispatch is a single command from your session; the actual coding runs in a Coder subagent. File dumps, test output, and retries stay there; only the outcome returns to your conversation.
- **Fast dispatch.** Coder keeps a single Codex engine warm in the background and hands tasks to it directly, instead of booting the CLI for every request. A handoff starts in seconds.
- **Unified permissions.** One permission model across agents, with three modes: **Read-only**, **Workspace-write**, and **Auto**. Auto is the default: safe commands run, dangerous ones are blocked, and anything in between is brought to you for a yes/no.
- **Tasks you can steer.** Every dispatch is a task. Check on it, read its result, give it follow-up instructions, or stop it, all by id, while it keeps working in the background.
- **Graceful fallback.** If Codex can't start (auth, usage limits, not installed), the task flows to a Claude subagent with the same instructions. You configure the chain and the default model and effort for each agent.
- **Any model, anywhere.** Codex can point at local models (Ollama, LM Studio, and other OpenAI-compatible endpoints) and third-party providers, so Coder can run your tasks on those too - not just the hosted defaults. That opens up the whole scope of engines you can delegate to.

## Get started

Coder runs your tasks on an **engine CLI** - it needs at least one of the [codex CLI](https://github.com/openai/codex) (`npm install -g @openai/codex`, then `codex login`) or the [Claude Code CLI](https://github.com/anthropics/claude-code) (`npm install -g @anthropic-ai/claude-code`, then `claude auth login`) installed and logged in. `coder setup-host` reports which are ready; if none is, install one of them to run tasks.

Follow the install host specific guides below, then you can ask like:

> Use Coder to explain the directory structure of the workspace.

You can also add this to CLAUDE.md.

> Always use Coder for all implementation and system exploring tasks.

The work happens in the engine, and your session gets the result. Codex is the primary engine when available, with a Claude subagent as fallback.

### Cursor

```
/add-plugin Coder
```

### Claude Code

```
/plugin marketplace add muzam1l/coder

/plugin install coder@coder-plugins

/reload-plugins

/coder:setup
```

Or from the shell:

```
npm install -g @wular/coder
coder setup-host claude
```

### Codex

```
codex plugin marketplace add muzam1l/coder
codex plugin add coder@coder-plugins
```

Or from the npm directly:

```
npm install -g @wular/coder
coder setup-host codex
```

Note: Codex 'Approve for me' just disables invoking CLI agents, so just use 'Ask for approval'/'Full Access' when using Codex/ChatGPT app as host.

## Staying up to date

```bash
coder upgrade
```

It updates the CLI through whichever package manager installed it (npm, pnpm, yarn, or bun, auto-detected) and refreshes the host plugins to match. Narrow it with `--cli-only`, `--plugins-only`, `--codex`, `--claude`, or force a manager with `--pm <npm|pnpm|yarn|bun>`.

Set `CODER_NO_UPDATE_CHECK=1` to silence the update notice.

## Configuration

Machine defaults live in `~/.coder/config.json`; drop a `coder.config.json` in a repo to override per project.

```json
{
  "chain": ["codex", "claude"],
  "agents": {
    "codex": { "model": "terra", "effort": "high", "permissions": "auto" },
    "claude": { "model": "opus", "effort": "medium", "permissions": "auto" }
  }
}
```

## Advanced usage

You rarely need these - the agent drives tasks itself - but you can run them. Task commands live under `coder task <sub>`; the common ones have a top-level shortcut. Full docs: `coder --help`, `coder task <sub> --help`.

```bash
coder run "<text>"                # dispatch a task (--wait to block for the answer)
coder result [task-id]            # status + final answer (--wait blocks until done)
coder list [--all|--stopped]      # list tasks (running by default)
coder task steer <id> "<text>"    # continue a task with new instructions
coder task stop <id>              # interrupt it
coder task stream [id]            # watch the live progress log (you/debugging)
coder task archive <id>           # archive a session (--all-stopped for all finished)
coder task delete <id>            # delete a session (--all-archived for all archived)
coder task approve <id> <appr>    # answer an escalated permission (--deny)
```

`run`/`list`/`result`/`stream` are shortcuts for the `task` subcommand. Any `[task-id]` defaults to the most recent task and accepts a unique prefix.

Run flags (`run`/`steer`): `--wait` (foreground), `--agent codex|claude`, `--model spark|luna|terra|sol|opus|sonnet|fable`, `--effort low|medium|high`, `--permissions read-only|workspace-write|auto`, `--resume <task-id>`, `--json`.
