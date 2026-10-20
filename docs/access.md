# Access and approvals

Tasks run in a sandbox. In the `auto` permission mode each engine's own reviewer decides what may go beyond it: Claude's auto mode and Codex's auto review. Coder tells Claude's auto mode the task runs on a sandboxed machine and that reading the web, docs and package registries is fine.

## Escalations

When the reviewer refuses something, the task decides: it tries another way, or calls its `escalate` tool. Nothing escalates on its own. One request carries why and every exact command the step needs. It shows as **Approval needed**, the reason, then the actions folded under their count:

- `coder task approvals` and `coder task result`; `--json` lists the actions; `--wait` exits with code 4
- the dashboard
- the conversation it came from: Approve and Deny buttons on Slack, a select on Linear, `/approve <id>` and `/deny <id> <why>` replies on GitHub and Linear. Anyone with write access there can answer.

Deny asks why in the dashboard and on Slack; the reason is optional.

One answer covers every action. Answer any time, also after a deny:

```bash
coder task approve <id>                          # the task retries
coder task approve <id> --deny --reason "<why>"  # the task reads why
coder task approvals --denied                    # denied requests, still answerable
```

The task gets your answer as a message in its running turn; a task that ended resumes with it. Approved actions stay approved for the rest of the task: on Claude the exact approved command runs without review, on Codex the reviewer still judges each run.

Escalations exist only in `auto`.

## Pre-allowed hosts

Hosts in [`approvals.allowedNetworkHosts`](config.md#approvals) are reachable without review.

## Scratch folder

Each task gets `$TMPDIR/coder/<task-id>`, also its `TMPDIR` and package caches. Git writes work there and nowhere else. `coder task delete` removes it.
