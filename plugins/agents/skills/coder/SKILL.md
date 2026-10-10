---
name: coder
description: Use Coder for coding, implementation, or investigation tasks - features, fixes, refactors, debugging, tests, code questions - one coder per focused goal, fanned out in parallel, waiting on each task. Use it when asked, when a task needs another engine (Claude, Codex, custom), or when a subagent is sufficient or required for the task.
---

# Coder dispatch

If `CODER_WORKER` is set in your environment, you are a coder worker. Skip this skill and do your assigned work directly; nested dispatch is disabled.

You dispatch coding tasks through the `coder` runtime instead of implementing them yourself.

## Overview

Coder delegates coding to supervised subagents of any model - Codex, Claude, or any OpenAI-compatible or local endpoint - from one runtime on every host. Implementation details live in the subagents, so your context stays clean and handoffs are instant. Every task runs sandboxed under unified permissions (read-only, workspace-write, auto), is steerable mid-run, and falls back down the configured chain when an engine cannot start.

## Setup

If `coder` is not on PATH, install it yourself without asking: `npm install -g @wular/coder`. When a dispatch fails because engines are missing or logged out, run `coder setup-host` and follow its output. It checks engines and auth, fixes what it can, prints the exact fix for the rest, and is safe to re-run. Ask the user before installing an engine CLI or changing auth; if it updated codex, tell the user to restart their codex session.

## Using the CLI

- The CLI is the reference. `coder --help` and every subcommand's `--help` list the flags and exit codes, and each command prints the recommended next step when it returns. Follow it.
- `coder docs` lists the deeper guides; `coder docs <topic>` prints one.
- Wait on each task with `coder task result <task-id> --wait` in its own background shell, one per task, never several tasks in one call, so each approval and answer reaches you.
- If your harness sandboxes or gates terminal commands (Codex does both), run every `coder` command with escalated permissions; the runtime is a supervisor with its own sandbox and approval policy.

## Running tasks

Start with `coder task run --help`. It says how to write a good task and what happens after dispatch. `coder task --help` lists the rest, result, steer, stop, list and approvals. Then run it:

```bash
coder task run "Add a /health endpoint in src/server.ts that returns 200 with the git sha. Do not touch routes outside that file."
```

Follow what it prints.

## Flows

When the user asks for a repeatable multi-task workflow with verification gates and resume, author a Coder flow instead of hand-fanning tasks. Read `coder docs flows` before writing or editing one, preview with `--dry-run`, and once it runs give the user the real `coder flow watch <run-id>` command.
