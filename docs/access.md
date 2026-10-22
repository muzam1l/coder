# Access and approvals

Tasks, agents and connections run `auto` (default) or `read-only`. An `auto` task changes code and uses every tool, and the engine's reviewer decides what leaves the sandbox. A `read-only` task changes nothing and uses only read-only tools. The strictest wins: a read-only agent, parent task or connection makes the task read-only.

```bash
coder task run --access read-only "audit the auth module"
coder agent settings triage --access read-only
```

In the dashboard, pick it under **# Tasks → [New task]**, and per connection under **# Settings → (Connections)**.

## Approvals

When the reviewer refuses a step, the task tries another way or asks for approval, with the reason and the exact commands. The request shows as **Approval needed** in `coder task result`, on the task's page in **# Tasks**, and in the conversation the task came from. `--wait` exits with code 4.

```bash
coder task approvals                             # open requests
coder task approve <id>                          # the task retries
coder task approve <id> --deny --reason "<why>"  # the task reads why
coder task approvals --denied                    # denied, still answerable
```

In a conversation, anyone with write access answers: **[Approve]** or **[Deny]** on Slack, a select on Linear, `/approve <id>` or `/deny <id> <why>` on GitHub and Linear. Approved commands stay approved for the rest of the task. Only `auto` tasks ask.

## Agents in a thread

Ask an agent on Slack, GitHub or Linear to start work and follow it; results come back to the thread. It acts as its own app, and as you only through your Just me connection once you approve **Act as you on GitHub for this task?**.

- **At once**: starting, steering and stopping its tasks, and changing its own model and effort.
- **After [Approve] in the thread**: its other settings, workspace model changes and the default runner. Agent changes need a connected member, workspace changes an admin, personal ones the person who asked. A member can **[Ask an admin]**.
- **In the dashboard**: connections, credentials, models, runners, new agents and deletes. The agent replies with a filled-in link, so no key passes through it.

The tasks it starts get its repositories, connections and access, or less. It answers their approvals; what it can't approve comes to the thread.

## Who sees a task

On a Coder server, owners and admins see every task, and you see your own. Tasks from the dashboard, the CLI and public channels, repositories or teams show to every member. Tasks from DMs and private places show to members who can see that place, through their connected account; unknown privacy counts as private. A task started by another task follows it.

Whoever sees a task can steer, stop and delete it; a DM task only its author steers. Slack and GitHub membership changes show at once, Linear's on its next activity after a day.

## Sandbox

Each task gets a scratch folder, `$TMPDIR/coder/<task-id>`, for temp files, package caches and git writes; `coder task delete` removes it. Hosts in [`approvals.allowedNetworkHosts`](config.md#approvals) are reachable without review.
