---
name: handle
description: Use Coder for any coding, implementation, or investigation task - features, fixes, refactors, debugging, tests, code questions. You orchestrate, never implement yourself; dispatch through the `coder` CLI, one coder per focused goal, fanning out many coders in parallel as the work needs.
---

# Coder dispatch (Cursor host)

You dispatch coding tasks through the `coder` runtime instead of implementing them yourself. By default the runtime picks the engine from its configured chain; `--agent`/`--model`/`--effort` override it. You never spawn agents yourself; the runtime spawns and supervises them.

If `coder` is not on PATH, install it yourself without asking: `npm install -g @wular/coder`, then run `coder host-setup` to seed the config and check engine readiness (no host plugin is installed - Cursor gets this skill from the marketplace). Only if that fails, show the user the error and those commands. Coder needs at least one engine CLI installed and logged in: codex (`npm install -g @openai/codex`, then `codex login`) and/or claude (`npm install -g @anthropic-ai/claude-code`, then run `claude` once to log in) - ask the user before installing an engine CLI. The configured chain (`coder config`) decides which engine runs first and which is the fallback; set it with `coder config set chain <first>,<second>`.

When you run setup, also check codex is new enough for the default GPT-5.6 model, which needs codex `>= 0.144` (`codex --version`). If it is older, update it automatically without asking with `codex update` (codex's own updater; fall back to `npm install -g @openai/codex@latest` if it fails), then tell the user to restart their codex session so the update takes effect.

## Dispatching a task

- `coder` commands are safe to run in the terminal - the runtime is a supervisor: it spawns engines, keeps state in `~/.coder`, and enforces its own OS sandbox and approval policy on the task. If Cursor asks before running terminal commands, approve the `coder` calls (or allowlist the `coder` command).
- One coder per focused goal. When the work splits into independent parts, decompose it and dispatch each part as its own `coder task run` call - fan out a wide web of coders, not one giant dispatch. Give each coder a self-contained goal with all context - overview, file paths, constraints (read-only, git rules); use `steer` to continue a single coder's thread.
- Delegation is a hard gate for anything the engine can do itself: do not read source files, investigate, or write code first - no matter how simple the task. Fold into the task text whatever only you have - conversation context, results from tools the engine lacks. The coder worker runs with plugins disabled (no rules, skills, MCP, or connectors), so include any context only a rule or MCP tool of yours produced.
- Compose one self-contained task text (goal, relevant paths, constraints) and dispatch it. It backgrounds by default: the runtime does a startup check and prints a task id (or errors, see exit codes):

  ```bash
  coder task run "<task text>"
  ```

  Fetch the answer with `coder task result <task-id> --wait` - it blocks until the task finishes, then prints only the final result (keeps your context clean). Run it in a **background terminal** so it does not block you; if you can't, poll `coder task result <task-id>` (no `--wait`) until it is done. Or skip the two steps and block on the run itself with `--wait` on `coder task run`. A `--wait` exits **4** when the task is waiting on a permission approval: relay it to the user, apply their decision with `coder task approve <task-id> <approval-id> [--deny]`, then re-fetch with `coder task result <task-id> --wait` (unanswered approvals auto-deny after 120s and the task moves on).

- `coder task run` exits after its startup check. Exit 0: the task started - fetch its result (above). Exit 1: it failed to start / the turn failed - report it, do not retry.
- Exit 3: no engine in the chain could start; stdout carries a JSON payload (`fallback.action: "run-native-subagent"`). Mention the failure to the user (including any limit-reset time), then run the task with your own subagent facility: spawn one subagent whose prompt is the payload's `task` verbatim, prefixed with: "NEVER run git write operations (commit, checkout, stash, reset, push, etc.); leave changes uncommitted." If the payload's `permissions` is not `auto`, append it: `read-only` means investigate and report without modifying anything; `workspace-write` means never touch anything outside the workspace. Relay its output when it completes.
- Codex startup failures (auth, quota, rate limit) fall back to the next engine in the chain automatically - the runtime reruns the same task on the claude engine via its CLI and still exits 0, so just fetch the result. If it mentions a usage-limit reset time, relay that to the user.
- Engine, model, and effort come from config; add `--agent` / `--model` / `--effort` when the user asks or it is unambiguous from context (agents: `codex`, `claude`; codex models: `spark`, `luna`, `terra`, `sol`; claude models: `opus`, `sonnet`, `fable`; efforts: `low|medium|high`).
  - `spark` is only for the very lightest tasks (formatting, renames, quick lookups) - very fast and very cheap. It runs on a separate quota, so reach for it when the others hit a usage limit; it may still run once they are exhausted.
- Permissions default to auto mode. Pass `--permissions read-only` when the task is read-only; `--permissions workspace-write` to forbid any escalation beyond the project.
- A background dispatch prints a task id plus its result/steer/stop commands. Relay them and fetch the result (above) rather than polling.

## Controlling tasks

- Continue prior work ("keep going", "apply the top fix"): `coder task steer <task-id> "<follow-up>"`.
- Inspect: `coder task result <task-id>` (status + answer; add `--wait` to block until done) and `coder task list`. (`coder task stream <task-id>` streams the live progress log - to watch/debug in special cases, generally not for you to consume.)
- Interrupt: `coder task stop <task-id>`.
- If status shows `pendingApprovals`, surface them to the user; apply their decision with `coder task approve <task-id> <approval-id> [--deny]`.

## Hard rules

- Forward task text verbatim in `steer` and retries - never rewrite or summarize what the user asked for.
- Tell every coder, in its task text, to never run git write operations (commit, checkout, stash, reset, rebase, merge, push, etc.) and to leave changes uncommitted. The runtime's permission model also enforces this on the engines.
- Pass the user's constraints (read-only, scoped paths) into each coder's task text, and honor them over your own preferences.
