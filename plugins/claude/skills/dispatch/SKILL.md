---
name: dispatch
description: Use Coder to dispatch any coding, implementation, or investigation task - features, fixes, refactors, debugging, tests, code questions - one coder per focused goal, fanned out in parallel. Also covers Coder flows - TypeScript workflows running many tasks as one resumable wave.
---

# Coder dispatch (Claude host)

(If `CODER_WORKER` is set in your environment, you _are_ a coder worker: stop reading, skip this skill, and do your assigned work directly - nested dispatch is disabled.)

You dispatch coding tasks through the `coder` runtime instead of implementing them yourself.

## Overview

Coder delegates coding to supervised subagents of any model - Codex, Claude, or any OpenAI-compatible/local endpoint - from one runtime on every host. Implementation details live in the subagents, so your context stays clean and handoffs are instant; every task runs sandboxed under unified permissions (read-only · workspace-write · auto), steerable mid-run, falling back down the configured chain when an engine can't start.

`coder --help` is the cmd reference: every command and subcommand takes `--help` - reach for it instead of guessing flags.
Deeper guides ship with the CLI: `coder docs` lists them, `coder docs <topic>` prints one.

## Setup

If `coder` is not on PATH, install it yourself without asking (`npm install -g @wular/coder`). When a dispatch fails because engines are missing or logged out, run `coder setup-host claude` and follow its output - it checks engines and auth, fixes what it can, and prints the exact fix for the rest (safe to re-run anytime). Ask the user before installing an engine CLI or changing auth; if it updated codex, tell the user to restart their codex session. For a guided setup, suggest `/coder:setup`.

## Dispatching a task

- One coder per focused goal. When the work splits into independent parts, decompose it and dispatch each part as its own `coder task run` call - fan out a wide web of coders running in parallel, not one giant dispatch. Give each coder a self-contained goal with all context - overview, file paths, constraints (read-only, git rules). Run independent tasks concurrently; use `steer` to continue a single coder's thread.
- Delegation is a hard gate for anything the engine can do itself: do not read source files, investigate, or write code first - no matter how simple the task. Fold into the task text whatever only you have - conversation context, results from tools the engine lacks. The coder worker runs with plugins disabled (no skills, MCP, or connectors), so include any context only a plugin or MCP tool of yours produced.
- Compose one self-contained task text (goal, relevant paths, constraints) and dispatch it - it backgrounds by default and prints a task id:

  ```bash
  coder task run --system "<standing instructions>" "<task text>"
  ```

  Fetch the answer with `coder task result <task-id> --wait` - blocks until done, prints only the final result. Run it as a background Bash call (run_in_background: true) so it does not block you and you are re-invoked on completion; without one, poll without `--wait`, or put `--wait` on the run itself.

- A `--wait` (on `run` or `result`) exits **4** when the task is waiting on a permission approval: relay the approval to the user, apply their decision with `coder approve <task-id> <approval-id> [--deny]`, then re-fetch with `coder task result <task-id> --wait`. (Unanswered approvals auto-deny after 120s and the task moves on.)

- `coder task run` exits after its startup check. Exit 0: the task started - relay the task id and fetch its result (above). Exit 1: it failed to start or the turn failed - report it, do not retry or fall back yourself. Exit 3: no engine in the chain could start and stdout carries a `run-native-subagent` payload - see below.
- When the first engine can't start (auth, quota, rate limit), the runtime automatically falls back to the next engine in the chain, runs the same task on it, and still exits 0 - so just fetch the result. If the failure mentions a usage-limit reset time, relay that to the user.
- Model choice: config holds the defaults; matching the dispatch to the task is on you - pick `--agent` / `--model` / `--effort` by the task's weight and the user's ask (light -> cheap/fast model, hard -> stronger model or higher effort). `coder task run --help` lists agents, models, and efforts; `coder model list` shows custom models.
  - `spark` is only for the very lightest tasks (formatting, renames, quick lookups) - and it runs on a separate quota, so reach for it when the others hit a usage limit.
- Permissions default to auto mode (workspace-write + policy-answered escalations). Pass `--permissions read-only` when the task is read-only; `--permissions workspace-write` to forbid any escalation beyond the project.

## Flows (multi-task workflows)

When the user asks for a workflow - a repeatable multi-task wave with verification gates and crash/resume - author a Coder flow instead of hand-fanning tasks: a TypeScript file the runtime executes, written to `.coder/flows/<name>.ts` for the user to review. Before writing or editing one, always read the full reference first:

```bash
coder docs flows    # authoring conventions, primitives, resume rules
coder flow --help   # command reference
```

Preview with `--dry-run` before spending tokens - and note flow tasks are normal coder tasks, so steer/stop/list work on them.

For programmatic use - embedding coder in the user's own code or scripts - the SDK mirrors the CLI one-to-one; run `coder docs sdk` for the details.

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
