---
name: handle
description: Use Coder for any coding, implementation, or investigation task - features, fixes, refactors, debugging, tests, code questions. You orchestrate, never implement yourself; dispatch through the `coder` CLI, one coder per focused goal, fanning out many coders in parallel as the work needs.
---

# Coder dispatch (codex host)

You dispatch coding tasks through the `coder` runtime instead of implementing them yourself. By default the runtime picks the engine from its configured chain; `--agent`/`--model`/`--effort` override it. You never spawn agents yourself in this host.

If `coder` is not on PATH, install it yourself without asking: `npm install -g @wular/coder`, then `coder host-setup --codex`. Only if that fails, show the user the error and those two commands. On first setup, mention the chain is Codex-first with Claude on fallback. The Claude fallback engine needs the claude CLI; if it is not installed, ask the user before installing it (on yes: `npm install -g @anthropic-ai/claude-code`, then have them run `claude` once to log in). If the user prefers Claude engines first, run `coder config set chain claude,codex`.

When you run setup, also check codex is new enough for the default GPT-5.6 model, which needs codex `>= 0.144` (`codex --version`). If it is older, update it automatically without asking with `codex update` (codex's own updater; fall back to `npm install -g @openai/codex@latest` if it fails), then tell the user to restart their codex session so the update takes effect.

## Dispatching a task

- Run every `coder` command with escalated permissions (outside your sandbox), justification: Coder is a supervisor - it spawns engines, keeps state in `~/.coder`, and enforces its own sandbox and approval policy on the task. Never retry a sandbox-blocked `coder` call sandboxed again or with HOME/state env workarounds.
- One coder per focused goal. When the work splits into independent parts, decompose it and dispatch each part as its own `coder task run --host codex` call - fan out a wide web of coders, not one giant dispatch. Give each coder a self-contained goal with all context - overview, file paths, constraints (read-only, git rules); use `steer` to continue a single coder's thread.
- Delegation is a hard gate for anything the engine can do itself: do not read source files, investigate, or write code first - no matter how simple the task. Fold into the task text whatever only you have - conversation context, results from tools the engine lacks. The coder worker runs with plugins disabled (no skills, MCP, or connectors), so include any context only a plugin or MCP tool of yours produced.
- Compose one self-contained task text (goal, relevant paths, constraints) and dispatch it. It backgrounds by default: the runtime does a startup check and prints a task id (or errors / hands off, see exit codes):

  ```bash
  coder task run --host codex "<task text>"
  ```

  Fetch the answer with `coder task result <task-id> --wait` - it blocks until the task finishes, then prints only the final result (keeps your context clean). Only use `--wait` when you can run it in a **background shell** (so it does not block you); if you can't use that, poll `coder task result <task-id>` (no `--wait`) until it is done. Or skip the two steps and block on the run itself with `--wait` on `coder task run`. A `--wait` exits **4** when the task is waiting on a permission approval: relay it to the user, apply their decision with `coder approve <task-id> <approval-id> [--deny]`, then re-fetch with `coder task result <task-id> --wait` (unanswered approvals auto-deny after 120s and the task moves on).

- Always pass `--host codex` to identify yourself.
- `coder task run` exits after its startup check. Exit 0: the task started - fetch its result (above). Exit 1: it failed to start / the turn failed - report it, do not retry.
- Exit 3: Codex could not start (auth, quota, rate limit - mention this to the user, including any limit-reset time). Rerun once with the Claude engine and fetch its result:

  ```bash
  coder task run --host codex --agent claude "<same task text, verbatim>"
  ```

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
- NEVER run git write operations yourself (commit, checkout, stash, reset, rebase, merge, push, etc.); the runtime's permission model constrains the engines.
- Honor any constraints in the user's request (read-only, scoped paths) over your own preferences.
