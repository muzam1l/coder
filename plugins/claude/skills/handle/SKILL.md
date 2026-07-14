---
name: handle
description: Use Coder for any coding, implementation, or investigation task - features, fixes, refactors, debugging, tests, code questions. You orchestrate, never implement yourself; dispatch through the `coder` CLI, one coder per focused goal, fanning out many coders in parallel as the work needs.
---

# Coder dispatch (Claude host)

You dispatch coding tasks through the `coder` runtime instead of implementing them yourself. By default the runtime picks the engine from its configured chain; flags like `--agent`/`--model`/`--effort` override it.

Coder delegates coding to supervised subagents of any model, from your favorite harness. It is a local supervisor runtime (npm: `@wular/coder`): it spawns engine CLIs (OpenAI Codex, Anthropic Claude) as sandboxed workers, keeps task state in `~/.coder`, enforces its own permission/approval policy, and falls back down the configured chain when an engine can't start. Beyond the built-in models it runs **custom models** - any OpenAI-compatible endpoint, local (Ollama, vLLM, ...) or hosted (OpenRouter, ...) - added with `coder model add` and dispatched with `--model <name>` or `--agent custom` (they currently run on the codex engine; no login needed).

## Setup

If `coder` is not on PATH, install it yourself without asking (`npm install -g @wular/coder`). Assume nothing about setup state - the user may or may not have run setup. When a dispatch fails because engines are missing or logged out, run `coder setup-host claude` and follow its output: it checks engines and auth, seeds the config, installs the host plugin, auto-updates codex when too old for the default model, and prints the exact fix for anything not ready (safe to re-run anytime). Ask the user before installing an engine CLI or changing auth; if setup updated codex, tell the user to restart their codex session. For a guided setup, suggest `/coder:setup`.

## Dispatching a task

- One coder per focused goal. When the work splits into independent parts, decompose it and dispatch each part as its own `coder task run` call - fan out a wide web of coders running in parallel, not one giant dispatch. Give each coder a self-contained goal with all context - overview, file paths, constraints (read-only, git rules). Run independent tasks concurrently; use `steer` to continue a single coder's thread.
- Delegation is a hard gate for anything the engine can do itself: do not read source files, investigate, or write code first - no matter how simple the task. Fold into the task text whatever only you have - conversation context, results from tools the engine lacks. The coder worker runs with plugins disabled (no skills, MCP, or connectors), so include any context only a plugin or MCP tool of yours produced.
- Compose one self-contained task text (goal, relevant paths, constraints) and dispatch it. It backgrounds by default: the runtime does a startup check and prints a task id (or errors / hands off, see exit codes):

  ```bash
  coder task run "<task text>"
  ```

  Fetch the answer with `coder task result <task-id> --wait` - it blocks until the task finishes, then prints only the final result (keeps your context clean). Run it as a **background Bash call** so it does not block you and you are re-invoked on completion:

  ```bash
  coder task result <task-id> --wait   # Bash run_in_background: true
  ```

  Only use `--wait` when you can run it in a background shell like that; without one, poll `coder task result <task-id>` (no `--wait`) until it is done. Or skip the two steps and block on the run itself with `--wait` on `coder task run`.

- A `--wait` (on `run` or `result`) exits **4** when the task is waiting on a permission approval: relay the approval to the user, apply their decision with `coder approve <task-id> <approval-id> [--deny]`, then re-fetch with `coder task result <task-id> --wait`. (Unanswered approvals auto-deny after 120s and the task moves on.)

- `coder task run` exits after its startup check. Exit 0: the task started - relay the task id and fetch its result (above). Exit 1: it failed to start or the turn failed - report it, do not retry or fall back yourself. Exit 3: no engine in the chain could start and stdout carries a `run-native-subagent` payload - see below.
- When the first engine can't start (auth, quota, rate limit), the runtime automatically falls back to the next engine in the chain, runs the same task on it, and still exits 0 - so just fetch the result. If the failure mentions a usage-limit reset time, relay that to the user.
- Engine, model, and effort come from config; add `--agent` / `--model` / `--effort` when the user asks or it is unambiguous from context (agents: `codex`, `claude`, `custom`; codex models: `spark`, `luna`, `terra`, `sol`; claude models: `opus`, `sonnet`, `fable`; efforts: `low|medium|high`; custom models: any name from `coder model add` - list them with `coder model list`).
  - `spark` is only for the very lightest tasks (formatting, renames, quick lookups) - very fast and very cheap. It runs on a separate quota, so reach for it when the others hit a usage limit; it may still run once they are exhausted.
- Permissions default to auto mode (workspace-write + policy-answered escalations). Pass `--permissions read-only` when the task is read-only; `--permissions workspace-write` to forbid any escalation beyond the project.
- A background dispatch prints a task id plus its result/steer/stop commands. Relay them and fetch the result (above) rather than polling.

## Last resort: run-native-subagent payload (exit 3)

When no coder engine can start (missing binaries, auth, quota across the whole chain), the runtime exits 3 with a JSON payload (`fallback.action: "run-native-subagent"`). Mention the failure to the user (including any limit-reset time), then run the task with your own subagent facility: spawn one `general-purpose` subagent via the Agent tool whose prompt is the payload's `task` verbatim, prefixed with: "NEVER run git write operations (commit, checkout, stash, reset, push, etc.); leave changes uncommitted." If the payload's `permissions` is not `auto`, append it: `read-only` means investigate and report without modifying anything; `workspace-write` means never touch anything outside the workspace. Relay its output when it completes.

## Supervision loop

With coders running in the background, don't fire-and-forget: schedule recurring check-ins (the `/loop` skill or ScheduleWakeup; interval by the work's pace, 10m default). Each tick: `coder task list`, fetch finished results, dispatch newly unblocked coders, steer stuck ones, stop off-track ones, surface pending approvals. Stop the loop when all tasks are done and relayed.

## Controlling tasks

- Continue prior work ("keep going", "apply the top fix"): `coder task steer <task-id> "<follow-up>"`.
- Inspect: `coder task result <task-id>` (status + answer; add `--wait` to block until done) and `coder task list`. (`coder task stream <task-id>` streams the live progress log - to watch/debug in special cases, generally not for you to consume.)
- Interrupt: `coder task stop <task-id>`.
- If status shows `pendingApprovals`, surface them to the user; apply their decision with `coder task approve <task-id> <approval-id> [--deny]`.

## Hard rules

- Forward task text verbatim in `steer` follow-ups - never rewrite or summarize what the user asked for.
- Tell every coder to never run git write operations (commit, checkout, stash, reset, rebase, merge, push, etc.) and to leave changes uncommitted.
- Pass the user's constraints (read-only, scoped paths) into each coder's task text, and honor them over your own preferences.
