# Dashboard

The dashboard is Coder's web UI at `/dash`, which opens the current workspace at `/dash/<workspace>`. `coder dash` runs it on this machine as a UI over the CLI's own config, agents and tasks, with no account and no database.

To self-host your own Coder in the cloud, see [Self-hosting](self-host.md). There the same dashboard serves a workspace.

Paths name what you click: **# Page** in the sidebar, **(Tab)**, **[Button]**. **# Settings → (Engines)** opens the Engines tab of Settings.

`coder dash` is short for `coder server serve`:

```sh
coder dash               # http://localhost:8787
coder dash --port 3100
```

## Sign-in

- **Local**: `coder dash` prints a dashboard link that carries its admin token (`/dash#token=…`), new on each start unless `ADMIN_TOKEN` is set. The dashboard answers only on `localhost`, `127.0.0.1` and `[::1]` at its port.
- **Cloud**: members sign in with Wular Auth and switch workspaces from the menu. Members are managed in Wular Auth, and **# Settings** links there.

## Pages

**Agents**: agents from two sources; `coder agent list` lists them. Give one its own app from **# Agents → *agent* → (Platforms)**; its **(Usage)** lists the platform events it failed to handle in the last day.

- **Dashboard agents** are made in the editor, **# Agents → [New agent]**.
  - **Local**: saved in `~/.coder/agents/<id>/`.
  - **Cloud**: kept in the workspace; every change is a new version.
- **Repository agents** come from a repo's `.coder/agents/<id>/`, which `coder agent init` scaffolds.
  - **Local**: read from the repo the server runs in; edits are written back there.
  - **Cloud**: imported from GitHub on each push to the repo's branch, through the agent's app.

**Tasks**: start, watch, steer, ask, stop, approve and continue tasks, and run flows and reviews from **[New task]**; `coder task` does the same. On a local server a task can run in any folder on the machine; recent folders are offered first. **[Repository…]** clones an https or ssh git URL with the machine's own git logins into `~/.coder/checkouts` and runs the task there.

- **Local**: every task on this machine, including those started with `coder task run`.
- **Cloud**: the workspace's tasks, from the dashboard, `coder task run --server` and platform events. A task from a 1:1 DM shows only to its requester and to owners and admins. Its requester steers it; admins can view, stop and delete it.

Local dashboard tasks open as soon as their worker starts. If the engine then fails to start, the task shows the failure and its output. `coder task run` still waits for startup and tries the next engine in its chain.

Archiving hides a task from the default list. A running task keeps running, and steering an archived task brings it back.

**Usage**: tasks, runner time and tokens per day, and the top agents; `coder agent usage --server` in a terminal.

**Settings**: what every task runs with.

- **Connections**: MCP servers, accounts and API keys tasks reach, as `coder connection add` adds them.
- **Credentials**: the engine logins tasks run with.
  - **Local**: this machine's `claude` and `codex` logins, with **[Sign in]** and **[Sign out]** running each CLI's own commands here.
  - **Cloud**: encrypted personal and workspace [credentials](self-host.md#credentials), as `coder credentials add` adds them.
- **Engines** and **Models**: engine defaults and models.
  - **Local**: the user config, as `coder config` and `coder model` edit it.
  - **Cloud**: the workspace's config, which a repo's own `.coder/config.json` can only narrow.
- **Runners**: where tasks run, each with its own engine logins; `coder runner add` adds one.
  - **Local**: this machine.
  - **Cloud**: the server's default runner plus the [runners](self-host.md#runners) you add. Personal runners are yours; workspace runners need an owner or admin. Secrets are encrypted.

Add a runner from the catalog under **# Settings → (Runners)**. Your own machine pairs with one command, `coder runner serve --url <server> --token <token>`, behind a public HTTPS tunnel (`--runner-url`). The token lasts 15 minutes and works once. A paired machine calls home every minute and shows offline after five without one. Local and Docker kinds exist only on a local server.

A task runs on the runner it names, else its agent's runner, your default, the workspace default, then the server's own.

For GitHub Actions, save `coder server workflow` as `.github/workflows/coder-agent.yml` and select that file in the runner form. Its worker command is `coder agent run --task`; the task result comes back through the server callback. Job logs appear after GitHub archives them when the job finishes. For Vercel Sandbox, supply the team and project IDs, or set `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID` on the server. Sandbox logs stream while the task runs. See [runner setup](self-host.md#runners) for authentication and workflow inputs.

## Platform events

Agents answer GitHub, Slack and other platforms only when the platform can reach the server.

- **Local**: open a tunnel (`ngrok http 8787`, `cloudflared tunnel --url http://localhost:8787`, or VS Code's Ports panel set to Public) and restart with `PUBLIC_URL` set to the tunnel's URL. The tunnel serves only webhooks and app setup callbacks, never the dashboard or `/admin`.
- **Cloud**: platforms reach it at its own `PUBLIC_URL`.
