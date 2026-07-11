---
name: handle
description: Use Coder for any coding, implementation, or investigation task - features, fixes, refactors, debugging, tests, code questions. You orchestrate, never implement yourself; dispatch through the `coder` CLI, one coder per focused goal, fanning out many coders in parallel as the work needs.
---

# Coder dispatch

You dispatch coding tasks through the `coder` runtime instead of implementing them yourself. By default the runtime picks the engine from its configured chain; Flags like `--agent`/`--model`/`--effort` override it.

If `coder` is not on PATH, install it yourself without asking (`npm install -g @wular/coder`), then continue; suggest the user run `/coder:setup` to configure the engines and chain.

## Dispatching a task

- One coder per focused goal. When the work splits into independent parts, decompose it and dispatch each part as its own background `coder task` - fan out a wide web of coders running in parallel, not one giant dispatch. Give each coder a self-contained goal with all context - overview, file paths, constraints (read-only, git rules). Run independent tasks concurrently; use `steer` to continue a single coder's thread.
- Delegation is a hard gate for anything the engine can do itself: do not read source files, investigate, or write code first - no matter how simple the task. Fold into the task text whatever only you have - conversation context, results from tools the engine lacks. The coder worker runs with plugins disabled (no skills, MCP, or connectors), so include any context only a plugin or MCP tool of yours produced.
- Compose one self-contained task text (goal, relevant paths, constraints) and dispatch it. It backgrounds by default: the runtime does a startup check and prints a task id (or errors / hands off, see exit codes):

  ```bash
  coder task run --host claude "<task text>"
  ```

  Fetch the answer with `coder task result <task-id> --wait` - it blocks until the task finishes, then prints only the final answer (keeps your context clean). Run it as a **background Bash call** so it does not block you and you are re-invoked on completion:

  ```bash
  coder task result <task-id> --wait   # Bash run_in_background: true
  ```

  Only use `--wait` when you can run it in a background shell like that; without one, poll `coder task result <task-id>` (no `--wait`) until it is done. Or skip the two steps and block on the run itself with `--wait` on `coder task run`.

- A `--wait` (on `run` or `result`) exits **4** when the task is waiting on a permission approval: relay the approval to the user, apply their decision with `coder approve <task-id> <approval-id> [--deny]`, then re-fetch with `coder task result <task-id> --wait`. (Unanswered approvals auto-deny after 120s and the task moves on.)

- Always pass `--host claude` to identify yourself.
- `coder task run` exits after its startup check. Exit 0: the task started - relay the task id and fetch its result (above), BUT if stdout is a `spawn-claude-subagent` payload (Claude is the configured engine), this is a clean delegation - spawn the subagent as below, do not treat it as a result. Exit 1: it failed to start - report it, do not retry or fall back yourself. Exit 3: Codex failed to start and handed off to Claude (see below).
- Engine, model, and effort come from config; add `--agent` / `--model` / `--effort` when the user asks or it is unambiguous from context (agents: `codex`, `claude`; codex models: `spark`, `luna`, `terra`, `sol`; claude models: `opus`, `sonnet`, `fable`; efforts: `low|medium|high`).
  - `spark` is only for the very lightest tasks (formatting, renames, quick lookups) - very fast and very cheap. It runs on a separate quota, so reach for it when the others hit a usage limit; it may still run once they are exhausted.
- Permissions default to auto mode (workspace-write + policy-answered escalations). Pass `--permissions read-only` when the task is read-only; `--permissions workspace-write` to forbid any escalation beyond the project.
- A background dispatch prints a task id plus its result/steer/stop commands. Relay them and fetch the result (above) rather than polling.

## Claude engine (spawn-claude-subagent payload)

The runtime prints a `spawn-claude-subagent` payload instead of running Codex when Claude should handle the task. Its `reason` field says why, and the exit code follows from it:

- `configured` (Claude is the selected engine): a planned delegation, so the runtime **exits 0** - present it as delegation, not an error.
- `codex-failed` (Codex missing, auth, quota, rate limit): the runtime **exits 3** and wraps the payload under a `fallback` key alongside an `error` string - mention the failure to the user, including any limit-reset time, then spawn the subagent.

Spawn one `general-purpose` subagent via the Agent tool, passing the payload's `model` as the Agent tool's model parameter. Its prompt is the original task text verbatim, prefixed with: "NEVER run git write operations (commit, checkout, stash, reset, push, etc.); leave changes uncommitted." Append the same for the payload's `permissions` if not the default `auto`: `read-only` means investigate and report without modifying anything; `workspace-write` means never touch anything outside the workspace.

Relay its output when it completes.

## Controlling tasks

- Continue prior work ("keep going", "apply the top fix"): `coder task steer <task-id> "<follow-up>"`.
- Inspect: `coder task result <task-id>` (status + answer; add `--wait` to block until done) and `coder task list`. (`coder task stream <task-id>` streams the live progress log - to watch/debug in special cases, generally not for you to consume.)
- Interrupt: `coder task stop <task-id>`.
- If status shows `pendingApprovals`, surface them to the user; apply their decision with `coder task approve <task-id> <approval-id> [--deny]`.

## Hard rules

- Forward task text verbatim in `steer` and fallback prompts - never rewrite or summarize what the user asked for.
- Tell every coder to never run git write operations (commit, checkout, stash, reset, rebase, merge, push, etc.) and to leave changes uncommitted - the Claude subagent prompt already prefixes this, and the runtime's approval policy enforces it for Codex.
- Pass the user's constraints (read-only, scoped paths) into each coder's task text, and honor them over your own preferences.
