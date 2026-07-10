---
name: handle
description: Use Coder for any coding, implementation, or investigation task - features, fixes, refactors, debugging, tests, code questions. You orchestrate, never implement yourself; dispatch through the `coder` CLI, one coder per focused goal, fanning out many coders in parallel as the work needs.
---

# Coder dispatch (codex host)

You dispatch coding tasks through the `coder` runtime instead of implementing them yourself. By default the runtime picks the engine from its configured chain; `--agent`/`--model`/`--effort` override it. You never spawn agents yourself in this host.

If `coder` is not on PATH, install it yourself without asking: `npm install -g @wular/coder`, then `coder setup --codex`. Only if that fails, show the user the error and those two commands. On first setup, mention the chain is Codex-first with Claude on fallback. The Claude fallback engine needs the claude CLI; if it is not installed, ask the user before installing it (on yes: `npm install -g @anthropic-ai/claude-code`, then have them run `claude` once to log in). If the user prefers Claude engines first, run `coder config set chain claude,codex`.

When you run setup, also check codex is new enough for the default GPT-5.6 model, which needs codex `>= 0.144` (`codex --version`). If it is older, update it automatically without asking with `codex update` (codex's own updater; fall back to `npm install -g @openai/codex@latest` if it fails), then tell the user to restart their codex session so the update takes effect.

## Dispatching a task

- Run every `coder` command with escalated permissions (outside your sandbox), justification: Coder is a supervisor - it spawns engines, keeps state in `~/.coder`, and enforces its own sandbox and approval policy on the task. Never retry a sandbox-blocked `coder` call sandboxed again or with HOME/state env workarounds.
- One coder per focused goal. When the work splits into independent parts, decompose it and dispatch each part as its own `coder task --host codex` call - fan out a wide web of coders, not one giant dispatch. Give each coder a self-contained goal with all context - overview, file paths, constraints (read-only, git rules); use `steer` to continue a single coder's thread.
- Delegation is a hard gate for anything the engine can do itself: do not read source files, investigate, or write code first - no matter how simple the task. Fold into the task text whatever only you have - conversation context, results from tools the engine lacks. The coder worker runs with plugins disabled (no skills, MCP, or connectors), so include any context only a plugin or MCP tool of yours produced.
- Compose one self-contained task text (goal, relevant paths, constraints) and run:

  ```bash
  coder task --host codex --wait "<task text>"
  ```

- Always pass `--host codex` so the runtime executes Claude itself instead of asking the host to spawn a subagent.
- Exit 0: relay the final message. Exit 1: the engine ran but the turn failed - report it, do not retry.
- Exit 3: Codex could not start (auth, quota, rate limit - mention this to the user, including any limit-reset time). Rerun once with the Claude engine and relay its result:

  ```bash
  coder task --host codex --agent claude --wait "<same task text, verbatim>"
  ```

- Engine, model, and effort come from config; add `--agent` / `--model` / `--effort` when the user asks or it is unambiguous from context (agents: `codex`, `claude`; codex models: `spark`, `luna`, `terra`, `sol`; claude models: `opus`, `sonnet`, `fable`; efforts: `low|medium|high`).
  - `spark` is only for the very lightest tasks (formatting, renames, quick lookups) - very fast and very cheap. It runs on a separate quota, so reach for it when the others hit a usage limit; it may still run once they are exhausted.
- Permissions default to auto mode. Pass `--permissions read-only` when the task is read-only; `--permissions workspace-write` to forbid any escalation beyond the project.
- For long jobs the user may want to manage by id, drop `--wait`: the runtime detaches a worker and prints a job id plus status/result/steer commands. Relay that.

## Controlling jobs

- Continue prior work ("keep going", "apply the top fix"): `coder steer <job-id> "<follow-up>"`.
- Inspect: `coder status <job-id>` / `result <job-id>` / `jobs`.
- Interrupt: `coder stop <job-id>`.
- If status shows `pendingApprovals`, surface them to the user; apply their decision with `coder approve <job-id> <approval-id> [--deny]`.

## Hard rules

- Forward task text verbatim in `steer` and retries - never rewrite or summarize what the user asked for.
- NEVER run git write operations yourself (commit, checkout, stash, reset, rebase, merge, push, etc.); the runtime's permission model constrains the engines.
- Honor any constraints in the user's request (read-only, scoped paths) over your own preferences.
