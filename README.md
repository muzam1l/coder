<div align="center">

# Coder

**Delegate coding to subagents of any model from your favorite harness.**

</div>

## Why Coder

- **Cross-harness.** One runtime, every host. The same subagents and models from Claude Code, Codex and more.
- **Cross-model.** Codex, Claude, any OpenAI-compatible endpoint, or local models. Pick per task.
- **Clean context.** Your conversation stays about intent and orchestration; implementation details live in the subagents.
- **Fast dispatch.** Handoffs are instant, and light enough to spin up a large number of subagents at once.
- **Steerable tasks.** Full visibility into every task, from live progress to mid-run course corrections.
- **Unified permissions.** Three modes across all engines: _Read-only_, _Workspace-write_, and _Auto_.

## Get started

**1. Install into your host.**

**Claude Code** - from inside a session:

```
/plugin marketplace add muzam1l/coder
/plugin install coder@coder-plugins
/reload-plugins
/coder:setup
```

Or from the shell:

```bash
npm install -g @wular/coder
coder setup-host claude
```

**Others** - Codex, Pi, OpenCode, and anything else that reads the Agent Skills standard dir (`~/.agents/skills`):

```bash
npm install -g @wular/coder
coder setup-host agents
```

**2. Connect at least one engine.** Either an engine CLI, logged in, to use that subscription:

```bash
npm install -g @openai/codex && codex login
# and/or
npm install -g @anthropic-ai/claude-code && claude auth login
```

Or a local/provider model of your own (see [Bring your own model](docs/custom-models.md)). `coder setup-host` checks what's ready.

**3. Ask your host to use it:**

> Use Coder to explain the directory structure of the workspace.

Or make it the default in AGENTS.md/CLAUDE.md:

> Always use Coder for all implementation and system exploring tasks.

Recommended setup: Claude Code as host (fable low/medium) and Codex (terra) as engine - best for performance and cost distribution.

## Configuration

Machine defaults live in `~/.coder/config.json`; a `coder.config.json` in a repo overrides per project.

```json
{
  "chain": ["codex", "claude"],
  "agents": {
    "codex": { "model": "terra", "effort": "high", "permissions": "auto" },
    "claude": { "model": "opus", "effort": "medium", "permissions": "auto" }
  },
  "models": {
    "qwen": { "baseUrl": "http://localhost:11434/v1", "model": "qwen2.5-coder:32b" }
  }
}
```

## Staying up to date

```bash
coder upgrade
```

Updates the CLI through whichever package manager installed it and refreshes the host plugins to match. See `coder upgrade --help` for narrowing flags. Set `CODER_NO_UPDATE_CHECK=1` to silence the update notice.

## Advanced usage

You rarely need these - the host agent drives tasks itself - but everything is scriptable:

```bash
coder run "<text>"                     # dispatch a task (--wait to block for the answer)
coder list                             # list running tasks (--all for running & stopped)
coder result [task-id]                 # status + final answer (--wait blocks until done)
coder task steer <task-id> "<text>"    # continue a task with new instructions
coder task stop <task-id>              # interrupt it
coder task stream [task-id]            # watch the live progress log
coder task approve <task-id> <appr-id> # answer an escalated permission (--deny)
```

Any `[task-id]` defaults to the most recent task.

Full docs: `coder --help`.
