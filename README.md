<div align="center">

# Coder

### Delegate the coding. Keep your context.

</div>

One runtime that hands your coding tasks to the best engine available and lets you steer, inspect, or stop any job while it works.

Plugs into Claude Code or Codex to enable the harness with Coder instances.

## Why Coder

- **A clean main thread.** Installed in Claude Code or Codex, dispatch is a single command from your session; the actual coding runs in a Coder subagent. File dumps, test output, and retries stay there; only the outcome returns to your conversation.
- **Fast dispatch.** Coder keeps a single Codex engine warm in the background and hands tasks to it directly, instead of booting the CLI for every request. A handoff starts in seconds.
- **Unified permissions.** One permission model across agents, with three modes: **Read-only**, **Workspace-write**, and **Auto**. Auto is the default: safe commands run, dangerous ones are blocked, and anything in between is brought to you for a yes/no.
- **Jobs you can steer.** Every task is a job. Check on it, read its result, give it follow-up instructions, or stop it, all by id, while it keeps working in the background.
- **Graceful fallback.** If Codex can't start (auth, usage limits, not installed), the task flows to a Claude subagent with the same instructions. You configure the chain and the default model and effort for each agent.

## Get started

### Claude Code

```
/plugin marketplace add muzam1l/coder

/plugin install coder@coder

/reload-plugins

/coder:setup
```

Or from the shell:

```
npm install -g @wular/coder
coder setup --claude
```

It shall use Coder automatically or you can also manually ask like:

> Use Coder to fix the failing date tests in packages/utils.

The work happens in the engine, and your session gets the result. Codex is the primary engine when available, with a Claude subagent as fallback.

### Codex

```
codex plugin marketplace add muzam1l/coder
codex plugin add coder@coder
```

Or from the npm directly:

```
npm install -g @wular/coder
coder setup --codex
```

Restart Codex and it dispatches coding tasks through the same runtime, with Claude run directly by Coder when it is the selected or fallback engine.

## Configuration

Machine defaults live in `~/.coder/config.json`; drop a `coder.config.json` in a repo to override per project.

```json
{
  "chain": ["codex", "claude"],
  "agents": {
    "codex": { "model": "gpt-5.5", "effort": "medium", "permissions": "auto" },
    "claude": { "model": "opus", "permissions": "auto" }
  }
}
```

## Advanced usage

You rarely need these: the agent creates and controls jobs on its own. But you can ask it explicitly ("steer that job", "approve that command", "stop it"), or run the commands yourself:

```bash
coder task "<text>"              # run a task in the background (--wait to block)
coder status [job]               # progress and pending approvals
coder result [job]               # the final answer
coder steer <job> "<follow-up>"  # continue a job with new instructions
coder stop <job>                 # interrupt it
coder approve <job> <id>         # answer an escalated permission (--deny)
```

Common flags:

| Flag             | Values                                                          | Default         |
| ---------------- | --------------------------------------------------------------- | --------------- |
| `--wait`         | run in the foreground and print the answer                      | background      |
| `--agent`        | `codex`, `claude`                                               | first in`chain` |
| `--model`        | `5.5`, `spark`, `opus`, `sonnet`, `fable` or any raw model slug | from config     |
| `--effort`       | `low`, `medium`, `high`                                         | from config     |
| `--permissions`  | `read-only`, `workspace-write`, `auto`                          | `auto`          |
| `--resume <job>` | continue that job's thread instead of starting fresh            | fresh run       |
