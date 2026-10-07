# Self-hosting

Run your own instance of the Coder server. A server holds the agents and their platform apps, every task with its output, and the dashboard. Platforms deliver events to it, runners report back to it, and the CLI and SDK reach it with `--server`. The hosted service at `coder.wular.ai` is the default.

## Deploy

One server, one database, any number of agents, running on Bun. The server is configured through its environment.

Required variables carry a *.

| Variable                                   | Type                                                                       | Default                                         | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`<sup><b>*</b></sup>            | url without a path                                                         |                                                 | The address platforms and browsers reach the server at. Written into every app as its webhook and callback address, and the only origin sign-in trusts. Inferred on Vercel; `serve` defaults to `http://localhost:<port>`                                                                                                                                                                                                                           |
| `DATABASE_URL` or `POSTGRES_URL`           | url                                                                        |                                                 | Postgres. Everything lives in a `coder` schema, so the database can be shared with other apps; a `coder` schema Coder did not create is refused. Run `coder server migrate` before the first start and after upgrades. Without it `coder server serve` runs the local dashboard; `--memory` selects a throwaway test server. Statements are prepared on each connection, so a query costs one round trip; add `?prepare=false` to the URL for a pooler that cannot keep prepared statements |
| `SERVER_ENCRYPTION_KEY`<sup><b>*</b></sup> | base64 32 bytes                                                            |                                                 | Encrypts app keys, tokens, and engine credentials at rest (`openssl rand -base64 32`), and derives the session cookie key and the sign-in client key with HKDF. Required with Postgres                                                                                                                                                                                                                                                              |
| `AUTH_WULAR_URL`                           | url                                                                        | `https://auth.wular.ai`                         | Wular Auth OpenID issuer, the only identity provider, including for a self-hosted Wular Auth deployment                                                                                                                                                                                                                                                                                                                                             |
| `RUNNER`                                   | `local`\| `local-docker` \| `vercel-sandbox` \| `github-actions` \| `http` | `local`, `vercel-sandbox` on Vercel             | Where tasks execute. `local` and `local-docker` run them on the server's own machine and work with the memory store, and are refused on Vercel. The other three run them elsewhere and need Postgres. Members' own machines add to this ([Your own machine](#your-own-machine))                                                                                                                                                                     |
| `RUNNER_CONFIG`                            | JSON                                                                       | `{}`                                            | Options for the chosen runner ([Runners](#runners)). Required for `http` and `github-actions`                                                                                                                                                                                                                                                                                                                                                       |
| `SERVER_ENCRYPTION_KEY_PREVIOUS`           | base64 32 bytes                                                            |                                                 | The old key, accepted until `coder server rotate-key` has re-sealed everything. While set, its sign-in key stays published and its session cookies still open, so rotation keeps everyone signed in                                                                                                                                                                                                                                                 |
| `PORT`                                     | number                                                                     | `8787`, or the port of a localhost `PUBLIC_URL` | Listen port                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `HOST`                                     | address                                                                    | `127.0.0.1` without a database, else all        | Listen address. A local server listens on loopback only ([Modes](#modes))                                                                                                                                                                                                                                                                                                                                                                           |
| `ADMIN_TOKEN`                              | string                                                                     | minted and printed per run                      | Local and memory servers. The bearer the CLI and dashboard use, accepted from loopback only. Ignored with Postgres                                                                                                                                                                                                                                                                                                                                  |
| `CODER_CACHE_HOME`                         | path                                                                       | OS cache directory for `wular-coder`            | Archived tasks, flows and usage                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `WORK_DIR`                                 | path                                                                       | `<tmp>/coder`                                   | Where the local runner checks out repositories                                                                                                                                                                                                                                                                                                                                                                                                      |
| `SERVER_NAME`                              | string                                                                     | `Coder`                                         | What the dashboard calls this server, in its sidebar server menu                                                                                                                                                                                                                                                                                                                                                                                    |
| `SERVER_LIMITS`                            | JSON                                                                       | `{}`                                            | Request rates and task slots ([Limits and monitoring](#limits-and-monitoring))                                                                                                                                                                                                                                                                                                                                                                      |
| `CLAUDE_SUBSCRIPTIONS`                     | `1`                                                                        | off                                             | Offer "Sign in with Claude" for personal credentials                                                                                                                                                                                                                                                                                                                                                                                                |
| `CODEX_SUBSCRIPTIONS`                      | `1`                                                                        | off                                             | Offer "Sign in with Codex" for personal credentials                                                                                                                                                                                                                                                                                                                                                                                                 |
| `MAX_TASKS`                                | number                                                                     | unset                                           | Optional deployment-wide runner slot cap, in addition to `limits.concurrentTasks`                                                                                                                                                                                                                                                                                                                                                                   |
| `MAX_QUEUED`                               | number                                                                     | `1000`                                          | Tasks a workspace may have waiting                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `TASK_TIMEOUT`                             | ms                                                                         | `1800000` (30 minutes)                          | Longest a task may run                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `TASK_STALL`                               | ms                                                                         | `300000` (5 minutes)                            | Silence before the runner is asked whether the task is still alive                                                                                                                                                                                                                                                                                                                                                                                  |
| `TASK_ATTEMPTS`                            | number                                                                     | `2`                                             | Times a runner start is retried                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SERVER_INTEGRATIONS`                      | comma-separated ids                                                        | every platform                                  | The platforms this server offers, from `github`, `slack`, `teams`, `gmail` and `linear`. Others get no webhook, catalog entry or app creation. An unknown id stops the server                                                                                                                                                                                                                                                                       |

Settings, sign-in, pairings and live tasks live in ~/.coder (CODER_HOME). Archived tasks, flows and usage live in the OS cache directory, ~/Library/Caches/wular-coder on macOS, ~/.cache/wular-coder on Linux (CODER_CACHE_HOME overrides). Nothing is ever pruned.

### Modes

| Started with   | Mode                                                                                   |
| -------------- | -------------------------------------------------------------------------------------- |
| `DATABASE_URL` | Cloud: sign-in with Wular Auth, workspaces, Postgres                                   |
| `--memory`     | Test server: everything in memory, the admin token, and a "not for production" warning |
| neither        | Local: the [dashboard](dash.md) for this machine's CLI, on loopback only               |

A memory server refuses to start on Vercel. Without a database, a connection from another machine reaches only the platform endpoints (`/hooks/`, `/create/`, `/install/`, `/connect/`), so `--host 0.0.0.0` lets platforms reach a memory server directly while the dashboard and `/admin` stay on this machine.

### Vercel

The fastest way. The [Vercel template](../src/server/deploy/vercel/README.md) has a Deploy button that creates the project with Postgres and asks only for `SERVER_ENCRYPTION_KEY`. Wular Auth sign-in is enabled automatically. `PUBLIC_URL` is the deployment's own address.

### Other serverless hosts

Mount `server.handler(env)` from the SDK as the request handler in a function that runs on Bun. Pass the platform's background-work hook as the second argument to keep task startup and other background work alive after the response goes out.

```ts
import { server } from '@wular/coder';
import { waitUntil } from '@vercel/functions';

const handler = server.handler(process.env);
export const GET = (request: Request) => handler(request, waitUntil);
export const POST = GET;
```

Run `await handler.scheduled()` from an hourly scheduled job to sweep expired state across every workspace, renew platform subscriptions, and start queued tasks. Each call deletes bounded batches; run it more frequently when expiry traffic exceeds 1,000 entries per hour. Call `await handler.close()` when the host shuts down. Other active handlers retain their shared database pool until they close.

`DATABASE_POOL_MAX` sets the process pool limit, defaulting to 10 connections on a persistent host and 2 on Vercel. `DATABASE_IDLE_TIMEOUT` sets idle expiry in seconds, defaulting to 240 and 30 respectively. Set these before creating a handler; handlers sharing a database share the first pool's settings.

Completed tasks, their logs and usage remain until a task is explicitly deleted. Sandbox snapshots remain until replaced or deleted. Expiring deliveries, notes, engine sign-ins and chat state are cleaned by the sweep.

### Your own host

Install Bun and `@wular/coder`, set the variables above, run `coder server migrate`, then `coder server serve`. The command starts the server under Bun, listens on `PORT` (default 8787), and answers `/health`. Keep it alive with whatever supervises processes on that host. It listens on every interface, as containers and load balancers need; behind a proxy on the same machine, `--host 127.0.0.1` keeps it private. From code, `server.serve()`, `server.migrate()` and `server.rotateKey()` do the same.

### After the first start

Open `PUBLIC_URL` and sign in with Wular Auth. Workspaces and roles come from Wular Auth.

Add an engine [credential](#credentials), or the first task will only reply with a link asking for one.

Create the built-in agent's apps once per server with `coder server app create github` and `coder server app create slack`, run where the server's `DATABASE_URL` and `PUBLIC_URL` are set. Each opens a one-time page that posts the app's manifest to the platform; `--org <org>` creates the GitHub App under an organization you admin. These apps are public and shared by every workspace, and the app's credentials go straight to the server. Slack apps also need public distribution turned on in their settings on api.slack.com before other Slack workspaces can add them.

## Apps and installs

An agent's handle on a platform is its app. The built-in agent `coder` uses the server's shared apps, and it also answers `@coder` and messages that start with `coder` where its app is installed. A custom agent gets its own app from its Platforms tab in the dashboard, under your own GitHub account or an organization whose apps you manage, private to that account.

Installs always start from the dashboard. "Connect GitHub" and "Add to Slack" on the dashboard home add the built-in apps, and the Platforms tab installs an agent's own app. The server binds an install to the workspace that started it with a one-time, expiring state. On GitHub it also requires the installer to authorize the app and checks that the installation appears in their own `GET /user/installations`; on Slack it uses "Add to Slack" OAuth keyed by team. An install belongs to exactly one workspace, and webhooks route by installation. Removing or suspending an install on the platform stops it.

Each task gets the narrowest platform token: on GitHub an installation token for the event's repository with only the permissions its tools need, on Slack the install's bot token.

## Credentials

An engine credential names an engine (`claude`, `codex`, or `custom`) and holds one or more encrypted environment variables. A personal credential belongs to one member, who alone sees and uses it. A workspace credential serves every member; only owners and admins add, remove, or change it. Each scope has one default per engine. A task runs on its requester's personal default for the engine, then on the workspace default. Tasks with no known requester, such as events from unlinked platform users, use the workspace default only. Without either, the agent replies with a link to the Credentials page, open at that engine.

`CLAUDE_SUBSCRIPTIONS=1` and `CODEX_SUBSCRIPTIONS=1` turn on "Sign in with Claude" and "Sign in with Codex", for personal credentials only; both are off by default. Sign-in runs the official, unmodified `claude setup-token` or `codex login --device-auth` on the server's runner, and the dashboard stores the result. The page shows each credential masked, with the account email and plan where the CLI reports them.

API keys are personal for any member and workspace-wide for owners and admins. Built-in engines are checked with one models request unless `--no-check` is set. Without subscription sign-in, a member may paste their own `claude setup-token` output as a personal credential.

From a terminal, `coder credentials` adds, lists, removes and signs in credentials; it reads secrets from the environment or stdin and never prints them.

## Tasks

A task starts from the dashboard, `coder task run --server`, or a platform event. Its credential is the requester's own, then the workspace's; without one it is refused with a link that connects it. The server holds up to `limits.concurrentTasks` runner slots per workspace, including tasks waiting for a reply or approval. Set `MAX_TASKS` for an additional cap across all instances. `TASK_STALL`, `TASK_TIMEOUT` and `TASK_ATTEMPTS` bound each task.

A task is a conversation: steer it or ask it a question while it runs, and continue it once it has finished. Its output streams over Server-Sent Events, and a repo task's result includes the diff of its changes. The CLI's task commands take `--server` to do the same as the dashboard. A repo's own `.coder/config.json` can only narrow the workspace's config.

## Sign-in and workspaces

Wular Auth is the only identity provider. Coder is an OpenID Connect client with no accounts of its own and signs its requests with a key derived from `SERVER_ENCRYPTION_KEY`, so there is no client secret to register. Sessions refresh themselves as Wular Auth's tokens expire, and signing out also ends the Wular Auth session.

Workspaces come from Wular Auth, where members and roles are managed; the members page links there. Wular Auth sends an account in no workspace through its onboarding before it signs them in to Coder. Apps, installations, tasks, and credentials all belong to the selected workspace. Every member may see and use everything in the workspace; only owners and admins change workspace credentials.

From a terminal, `coder auth login` signs in with Wular Auth (`--device` shows a code to approve elsewhere) and keeps the session in `~/.coder/session.json`. Its tokens are issued for this server only. `--workspace <slug>` picks a workspace and `--server <url>` another instance. Servers must use HTTPS unless they are loopback, and the CLI confirms a new origin the first time it sees it (`--yes` acknowledges it in scripts).

A platform user who addresses an agent must be linked to a member of the workspace that owns the install. The first time an unknown user asks, the agent answers with a link: on Slack a private one-time link, on GitHub a link that signs them in with the app's own GitHub authorization, so no secret appears in a public comment. Write actions on GitHub also need the person's write access to the repository, checked with GitHub. Installing an app links the installer the same way. A trigger with `"actAs": "requester"` runs its tasks with the requester's own GitHub token, kept encrypted and refreshed.

## Runners

`RUNNER_CONFIG` is a JSON object read by the chosen runner. Every field is optional unless marked.

| Runner           | Field               | Default                         | Purpose                                                                                                                                                       |
| ---------------- | ------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`          |                     |                                 | none                                                                                                                                                          |
| `local-docker`   | `image`             | `node:22`                       | Image the task runs in                                                                                                                                        |
|                  | `memory`            | `4g`                            | `--memory`                                                                                                                                                    |
|                  | `cpus`              | `2`                             | `--cpus`                                                                                                                                                      |
|                  | `pidsLimit`         | `512`                           | `--pids-limit`                                                                                                                                                |
|                  | `network`           | `bridge`                        | `--network`                                                                                                                                                   |
| `vercel-sandbox` | `image`             | the SDK's default image         | Image the base snapshot starts from                                                                                                                           |
|                  | `token`             | deployment OIDC                 | Vercel access token for Sandbox; install `@vercel/sandbox` in the adapter app                                                                                 |
|                  | `team`              | `VERCEL_TEAM_ID`                | Team ID for access-token authentication                                                                                                                       |
|                  | `projectId`         | `VERCEL_PROJECT_ID`             | Project ID for access-token authentication                                                                                                                    |
|                  | `region`            | the database's region           | Sandbox region; inferred from an AWS region in the database host, else Vercel's default                                                                       |
|                  | `tools`             | `[]`                            | Extra global npm packages in the base snapshot, next to `claude`, `codex` and `coder`                                                                         |
|                  | `timeoutMs`         | `1800000`                       | Sandbox lifetime                                                                                                                                              |
|                  | `vcpus`             | `2`                             | Sandbox size                                                                                                                                                  |
| `github-actions` | `token` (required)  |                                 | GitHub token that may dispatch the workflow and read run logs                                                                                                 |
|                  | `repo`              | the event's repository          | `owner/name` holding the workflow                                                                                                                             |
|                  | `workflow`          | `coder-agent.yml`               | Workflow file to dispatch (`coder server workflow` prints it)                                                                                                 |
|                  | `ref`               | the repository's default branch | Branch to dispatch on                                                                                                                                         |
| `http`           | `url` (required)    |                                 | Your controller's base URL; it implements `POST /start`, `POST /messages/<handle>`, `GET /status/<handle>`, `GET /logs/<handle>?after`, `POST /stop/<handle>` |
|                  | `secret` (required) |                                 | Shared secret that signs every request over body, timestamp, and nonce                                                                                        |
|                  | `headers`           | `{}`                            | Extra headers sent with every request                                                                                                                         |

On `vercel-sandbox` every task gets its own microVM. A base snapshot holds `claude`, `codex` and `coder`, and each repository gets its own snapshot with the repository cloned and its dependencies installed. Both are built on first use and kept current. An API key never enters the sandbox: its firewall adds the key to requests to `api.anthropic.com` or `api.openai.com`, and the task sees a placeholder.

Access-token authentication needs a token, team ID and project ID. Settings → Runners accepts the IDs directly, or the adapter app can supply `VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`. A task started before its snapshot is ready installs the same engines and tools in its own sandbox before running.

For GitHub Actions, save the output of `coder server workflow` as `.github/workflows/coder-agent.yml` on the workflow repository's default branch. It accepts `task`, `server`, `token` and `mode`, names each run `Coder agent <task ID>`, and calls `coder agent run --task "$TASK"` with the callback URL and attempt token in the environment. The workflow token needs repository Actions read and write; a classic token for a private repository needs `repo`. A result returns through the authenticated task callback. No result artifact is required.

GitHub job logs become downloadable when the job finishes. The dashboard stream waits for the workflow to finish and copies those archived logs even if the task's result has already arrived. Vercel Sandbox streams stdout and stderr while the command runs.

The server stores steer, ask, approval and cancel messages before delivering them. Local workers receive them over a private Unix socket; HTTP controllers use the same signed requests as task starts, Docker uses the daemon's exec channel, and Vercel Sandbox uses `runCommand`. Workers acknowledge the applied sequence and save it across restarts. Unacknowledged messages retry on server events and the sweep, with backoff. A reconnect fetches pending messages once.

A runner adapter declares delivery support through its optional `push` method. The start environment tells the worker which mode to use. GitHub Actions has no inbound delivery channel, so it checks every four seconds with one indexed query that returns immediately. Four seconds balances interactive response time and request volume. All workers send a separate heartbeat every 30 seconds; idle push workers make no message requests after reconnect.

### Your own machine

A member runs the server's tasks on their own machine with `coder runner serve`. It uses the machine's own `claude` and `codex` logins, so no credential is needed. Expose its port with any tunnel, such as `cloudflared tunnel --url http://localhost:4100`, `ngrok http 4100`, `tailscale funnel 4100` or a public VS Code port, and pass the tunnel's address with `--url`. Each start registers the current address with the server as you (`coder auth login`), and stopping marks the runner offline, so a changing tunnel address is fine. Every request to it is signed with its own secret, kept in `~/.coder/runners.json`.

A runner runs only its owner's tasks. An owner or admin can register one with `--workspace` for every member. A task runs on the runner it names, else its agent's runner, the requester's default, the workspace default, then `RUNNER`. Choose a default with `coder runner default <id>`. `coder runner list`, `rename` and `remove`, and the dashboard's Settings, manage them.

## Security

The server only verifies, dedupes, and dispatches; agents run in the runner with one checkout, one short-lived platform token, and one engine credential. `permissions` is enforced by the engine sandbox, `tools` by the app's permissions and the MCP allowlist. App credentials are encrypted at rest.

## Limits and monitoring

`SERVER_LIMITS` is a JSON object stored under `limits` in the server config. Each value is a positive integer. Unset keys use these defaults.

| Config key                  | Default | Purpose                                                                                                  |
| --------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `limits.principalPerMinute` | `300`   | Requests per minute for each signed-in user, the memory server's admin token, or an authenticated runner |
| `limits.ipPerMinute`        | `60`    | Requests per minute for each unauthenticated IP                                                          |
| `limits.authPerMinute`      | `20`    | Sign-in, token and login requests per minute for each IP, on top of `ipPerMinute`                        |
| `limits.registerPerMinute`  | `10`    | Runner registrations per minute for each IP; includes pairing and returning-runner heartbeats                       |
| `limits.pairingPerMinute`   | `5`     | Pairing tokens per minute for each principal at `/admin/runners/pair`                                    |
| `limits.concurrentTasks`    | `10`    | Active task slots per workspace in cloud mode, or per server in local and memory modes                   |

For example, `SERVER_LIMITS='{"principalPerMinute":300,"ipPerMinute":60,"authPerMinute":20,"registerPerMinute":10,"pairingPerMinute":5,"concurrentTasks":10}'` sets every default explicitly. All `/admin/*`, `/runners/*`, sign-in and pairing requests use the same token-bucket implementation. A bucket starts full and refills continuously over a minute. A refused request returns `429`, a readable JSON `error` and `Retry-After` in seconds. Buckets and counters belong to each server process and reset on restart; serverless instances keep their own buckets.

Local hosts use the connection's peer IP. Vercel uses the IP supplied by its proxy. Other fetch hosts without a peer IP share one unauthenticated bucket; place an IP-aware limiter at their ingress. Client-supplied forwarding headers never select a bucket on a local host. Behind a reverse proxy, the peer bucket belongs to that proxy.

Running tasks and tasks waiting for approval hold slots. Further tasks remain queued, with “Waiting for a task slot” in their status, until a slot opens. `MAX_TASKS`, when set, also bounds runner slots across the deployment. The concurrent cap applies to tasks admitted by the server; standalone CLI tasks do not pass through the server, but active CLI tasks on a local server's machine are counted before it starts another task.

`GET /health` needs no sign-in and returns `{ ok, version, uptime, db, runners: { online, total } }`. `uptime` is seconds since this server process started. `db` is `ok` after a live database query, `down` when it fails, or `none` in local and memory modes. Registered runners are online when their last heartbeat is less than five minutes old. Health counts runners across all workspaces and returns `200` when healthy or `503` when the database or runner records cannot be read. Local mode keeps its usual loopback access restriction.

`GET /admin/metrics` requires an owner or admin of the selected workspace, or the memory server's admin token. It returns `tasks` with counts for every status among tasks created in the last 24 hours, `queueDepth` for all queued tasks, `runnersOnline`, `requests`, and `rateLimitRejections`. Task and runner counts belong to the selected workspace; request and rejection counters cover this server process since startup.
