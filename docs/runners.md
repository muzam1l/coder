---
description: Runners, the machines tasks run on; kinds, personal and workspace runners, pairing a member's machine, and which runner a task uses.
---

# Runners

A runner is the machine a task runs on, with its own engine logins. Manage them under **# Settings → (Runners)** or with `coder runner`.

## Kinds

| Kind | Runs tasks on |
| --- | --- |
| Server default | What the server's operator set (`RUNNER`, see [Self-host](self-host.md#runners)) |
| Your machine | A member's own computer, paired once; on a local server, Another machine |
| Vercel Sandbox | A fresh Vercel machine per task |
| GitHub Actions | A workflow run in a chosen repository |
| HTTP runner | Any controller that speaks the runner protocol |
| Docker on the server | A container on the server's machine; only on a local server |

## Personal or workspace

- **Personal:** runs only its owner's tasks. Any member adds one.
- **Workspace:** runs every member's tasks. Only owners and admins add one. Only a workspace runner, or the server default, can be an agent's runner.

Each scope has one default, set with `coder runner default <id>` or **[Make default]**.

## Trust levels

What a task's machine receives depends on who operates it, fixed when the task is admitted.

| Level | Runners | Engine credentials | Connections | Platform tokens | Codex sign-in refresh |
| --- | --- | --- | --- | --- | --- |
| Workspace | Server default, every workspace runner | The asker's own, then the workspace's | The asker's own and the workspace's | The event's installation at the task's tools, the agent's other installations, skill repositories | Any credential the task received |
| Member | Personal Vercel Sandbox, GitHub Actions, Docker | The asker's own only | The asker's own only | The event's installation, read-only | The asker's own only |
| External | Personal HTTP runner, a paired machine included | The asker's own only, else the machine's own logins | The asker's own only | The event's installation, read-only | None |

On a member or external runner, a task fails when its asker has no credential of their own for its model.

## A member's own machine

`coder runner serve` runs the server's tasks on this machine with its own `claude` and `codex` logins, so it needs no engine credential. The server reaches it through any public HTTPS tunnel, such as `cloudflared tunnel --url http://localhost:4100`, `ngrok http 4100` or `tailscale funnel 4100`.

- **Signed in** (`coder auth login`): `coder runner serve --url <tunnel address>`.
- **Paired from the dashboard:** **# Settings → (Runners) → [Add runner] → Your machine** shows a one-use token valid for 15 minutes. Then `coder runner serve --url <server> --token <token> --runner-url <tunnel address>`.

Each start registers the current tunnel address, so a changing address is fine. The runner calls home every minute and shows offline after five without one. `--workspace` (owners and admins) makes it run every member's tasks, with that machine's logins and files. A task's work folder stays across turns and goes when the task is deleted.

## Which runner a task uses

1. The runner the task names (`coder task run --runner`).
2. Its agent's runner.
3. The person's own default, on their own tasks and DMs.
4. The workspace default.
5. The server default.

A member's machine and an HTTP runner can use their machine's own engine logins. Every other kind needs an engine credential under **# Settings → (Credentials)**; which credentials reach the machine follows its [trust level](#trust-levels).

## GitHub Actions and Vercel Sandbox

- **GitHub Actions:** owners and admins can use the repository's GitHub connection; anyone else adds a token with Actions, Contents and Workflows write. Adding the runner commits `.github/workflows/coder-runner.yml`. Only the run Coder dispatched can get the task's token. Anyone with write access to the repository can change what that run does. Logs appear once GitHub archives the job.
- **Vercel Sandbox:** a token scoped to the team. An empty team is the account's default; an empty project is `vercel-sandbox-default-project`, created when missing. Logs stream while the task runs.
