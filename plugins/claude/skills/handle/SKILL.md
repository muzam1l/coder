---
name: handle
description: Use Coder for any coding, implementation, or investigation task - features, fixes, refactors, debugging, tests, questions about the code. You are the orchestrator - never implement tasks yourself; dispatch them through the `coder` CLI exactly as this skill instructs, never via your own subagents. Give it one focused, self-contained goal with all context - overview, file paths, constraints e.g. read-only, git rules.
---

# Coder dispatch

You dispatch coding tasks through the `coder` runtime instead of implementing them yourself. By default the runtime picks the engine from its configured chain; Flags like `--agent`/`--model`/`--effort` override it.

If `coder` is not on PATH, install it yourself without asking (`npm install -g @wular/coder`), then continue; suggest the user run `/coder:setup` to configure the engines and chain.

## Dispatching a task

- Delegation is a hard gate for anything the engine can do itself: do not read source files, investigate, or write code first - no matter how simple the task. Fold into the task text whatever only you have - conversation context, results from tools the engine lacks.
- Compose one self-contained task text (goal, relevant paths, constraints) and run it as a **background Bash call** so you are notified on completion instead of blocking or polling:

  ```bash
  coder task --wait "<task text>"   # Bash run_in_background: true
  ```

- The harness re-invokes you when the command exits. Exit 0: usually relay the final message, BUT if stdout is a `spawn-claude-subagent` payload (Claude is the configured engine), this is a clean delegation - spawn the subagent as below, do not treat it as a result. Exit 1: the engine ran but the turn failed - report it, do not retry or fall back yourself. Exit 3: Codex failed and handed off to Claude (see below).
- Engine, model, and effort come from config; add `--agent` / `--model` / `--effort` when the user asks or it is unambiguous from context (agents: `codex`, `claude`; codex models: `spark`, `5.5`; claude models: `opus`, `sonnet`, `fable`; efforts: `low|medium|high`).
- Permissions default to auto mode (workspace-write + policy-answered escalations). Pass `--permissions read-only` when the task is read-only; `--permissions workspace-write` to forbid any escalation beyond the project.
- For long jobs the user may want to manage by id, drop `--wait`: the runtime detaches a worker, does its own startup check, and prints a job id plus status/result/steer commands. Relay that and do not poll.

## Claude engine (spawn-claude-subagent payload)

The runtime prints a `spawn-claude-subagent` payload instead of running Codex when Claude should handle the task. Its `reason` field says why, and the exit code follows from it:
- `configured` (Claude is the selected engine): a planned delegation, so the runtime **exits 0** - present it as delegation, not an error.
- `codex-failed` (Codex missing, auth, quota, rate limit): the runtime **exits 3** and wraps the payload under a `fallback` key alongside an `error` string - mention the failure to the user, including any limit-reset time, then spawn the subagent.

Spawn one `general-purpose` subagent via the Agent tool, passing the payload's `model` as the Agent tool's model parameter. Its prompt is the original task text verbatim, prefixed with: "NEVER run git write operations (commit, checkout, stash, reset, push, etc.); leave changes uncommitted." Append the same for the payload's `permissions` if not the default `auto`: `read-only` means investigate and report without modifying anything; `workspace-write` means never touch anything outside the workspace.

Relay its output when it completes.

## Controlling jobs

- Continue prior work ("keep going", "apply the top fix"): `coder steer <job-id> "<follow-up>"`.
- Inspect: `coder status <job-id>` / `result <job-id>` / `jobs`.
- Interrupt: `coder stop <job-id>`.
- If status shows `pendingApprovals`, surface them to the user; apply their decision with `coder approve <job-id> <approval-id> [--deny]`.

## Hard rules

- Forward task text verbatim in `steer` and fallback prompts - never rewrite or summarize what the user asked for.
- NEVER run git write operations yourself (commit, checkout, stash, reset, rebase, merge, push, etc.); the runtime's approval policy enforces this for Codex.
- Honor any constraints in the user's request (read-only, scoped paths) over your own preferences.
