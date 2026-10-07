# SDK

Everything the CLI does, as a library. The SDK mirrors the CLI exactly: every command group is a namespace, every subcommand a function, with the same names and the same options (`coder --help` is the reference for both).

```ts
import coder from '@wular/coder';
// or pick namespaces: import { task, flow, model, config, auth, agent, server } from '@wular/coder';

const { taskId } = await coder.task.run('Explain this repo', {
  model: 'sol',
});

const res = await coder.task.result(taskId, { wait: true });

console.log(res.result?.finalMessage);
```

`task.run(prompt, { outputSchema })` takes a JSON Schema for the answer; the CLI takes the same JSON with `coder task run --output-schema '<schema>' "<prompt>"`. The schema is sent to the engine natively (Codex, Claude, custom endpoints) and never written into the stored prompt; only an endpoint that rejects schemas gets it as prompt text. A continuation keeps the task's schema unless given a new one.

SDK functions never print and never call `process.exit`; results come back as typed values and failures as a typed `CoderError` whose `code` says what went wrong. The case the CLI maps to exit code 3 (every engine in the chain failed to start) is `code: 'chain-exhausted'`, carrying the same fallback payload and its self-contained `fallback.instructions`; a task blocked on a permission is `'approval-pending'`, carrying the approval to answer.

## CLI to SDK mapping

| CLI                                                                                    | SDK                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coder run "<text>"`                                                                   | `task.run(prompt, opts?)`                                                                                                                                                                                                                             |
| `coder list`                                                                           | `task.list(opts?)`                                                                                                                                                                                                                                    |
| `coder result [id] [--wait] [--tail N] [--turns]`                                      | `task.result(id?, { wait?, tail? })` - returns `turns` (one entry per finished turn) alongside `result`                                                                                                                                               |
| `coder task steer <id> "<text>"`                                                       | `task.steer(id, text)`                                                                                                                                                                                                                                |
| `coder task ask <id> "<question>"`                                                     | `task.ask(id, question, { model?, effort? })` - read-only sidecar answer; the task's thread is never touched                                                                                                                                          |
| `coder task stop <id>`                                                                 | `task.stop(id)`                                                                                                                                                                                                                                       |
| `coder task watch [id] [--tail N]`                                                     | `task.stream(id?, { tail? })` - async iterable of progress events                                                                                                                                                                                     |
| `coder task approvals [id]`                                                            | `task.approvals(id?)`                                                                                                                                                                                                                                 |
| `coder task approve <id> <appr>`                                                       | `task.approve(id, approvalId, { deny? })`                                                                                                                                                                                                             |
| `coder task archive / delete <id>`                                                     | `task.archive(id)` / `task.delete(id)`                                                                                                                                                                                                                |
| `coder flow run / list / discover / result / watch / stop / resume / archive / delete` | the matching `flow.*` function; `flow.run(nameOrPath, { args?, concurrency?, maxTasks? })`, `flow.stream(id?)` for `watch`                                                                                                                            |
| `coder model add / update / remove / list / alias / unalias / disable / enable`        | the matching `model.*` function                                                                                                                                                                                                                       |
| `coder config get / set`                                                               | `config.get(key?)` / `config.set(key, value)`                                                                                                                                                                                                         |
| `coder mcp add / add-json / list / rm`                                                 | `mcp.add(name, { url?, command?, env?, header?, tools?, user? })` / `mcp.addJson(name, entry, { user? })` / `mcp.list()` / `mcp.remove(name, { user? })`                                                                                              |
| `coder setup-host [hosts...]`                                                          | `setupHost(hosts?)`                                                                                                                                                                                                                                   |
| `coder upgrade`                                                                        | `upgrade({ cliOnly?, pluginsOnly? })`                                                                                                                                                                                                                 |
| `coder docs [topic]`                                                                   | `docs(topic?)`                                                                                                                                                                                                                                        |
| `coder review [--base] [--head] [--pr] [--since] [--post]`                             | `review.run({ base?, head?, pr?, since?, post?, engine?, model?, effort? })` - returns `{ findings, summary, runId }`                                                                                                                                 |
| `coder auth login [--server] [--workspace] [--device] [--yes]`                         | `auth.login({ server?, organization?, device?, yes?, onCode?, open?, save? })` - the same Wular Auth sign-in; `open` gets the browser URL, `device` switches to the code flow; pass the workspace slug as `organization` when the account has several |
| `coder auth logout / status`                                                           | `auth.logout({ server? })` / `auth.status()` - the saved sessions, never their tokens                                                                                                                                                                 |
| `coder task <verb> --server [url]`                                                     | every `task.*` above with `{ server: true \| url, organization?, token?, yes? }` - acts on your server's tasks instead of local tasks                                                                                                                 |
| `coder agent list / show <id> / init [id] / push [id]`                                 | `agent.list({ server? })` / `agent.show(id, { server? })` / `agent.init(id)` / `agent.push(id?, { cwd?, server? })`                                                                                                                                  |
| `coder agent integrations list / show <id>`                                            | `agent.integrations.list()` / `agent.integrations.show(id)`                                                                                                                                                                                           |
| `coder agent run <agent> <event.json> [--server]`                                      | `agent.run(agent, event, { server?, wait?, flow?, cwd? })` - local, tools off; with `server`, a real task                                                                                                                                             |
| `coder agent run --task <id>`                                                          | `agent.runTask(id, options?)` - the runner form, not for application code                                                                                                                                                                             |
| `coder credentials list / add / remove / default`                                      | `credentials.list()` / `.add(label, { engine, env, workspace?, default?, noCheck? })` / `.remove(label, { workspace? })` / `.default(label, { workspace? })`, all with `{ server? }`                                                                 |
| `coder agent usage [--since] [--by]`                                                   | `agent.usage({ since?, by?, server?, cwd? })`                                                                                                                                                                                                         |
| `coder server serve / migrate / rotate-key`                                            | `server.serve(options?)` / `server.migrate(options?)` / `server.rotateKey(options?)`; `server.handler(env)` for serverless hosts, see [Self-hosting](self-host.md#deploy)                                                                             |

Options objects take the same names as the CLI flags, camelCased (`--max-tasks` becomes `maxTasks`, `--server` becomes `server`). Every server option accepts `organization`, the `--workspace` flag's slug, which overrides the saved workspace for that call. `server` falls back to `CODER_SERVER`, then the hosted service; authentication comes from `auth.login()`, or from `token` when supplied; `yes: true` acknowledges the first use of a new server origin in non-interactive code.

## Examples

Dispatch a wave and wait for all of it:

```js
import { task } from '@wular/coder';

const ids = await Promise.all(areas.map(a => task.run(`Audit ${a}`, { permissions: 'read-only' })));

const results = await Promise.all(ids.map(({ taskId }) => task.result(taskId, { wait: true })));
```

Follow a task live. Every event carries a `kind` such as `assistant`, `reasoning`,
`tool`, `tool-result`, `usage`, `status`, `steer`, or `error`, plus the fields
that kind implies (`tool`, `exitCode`, `durationMs`, `tokens`):

```ts
for await (const event of task.stream(taskId)) {
  if (event.kind === 'assistant') console.log(event.message);
}
```

Run a flow from your own tooling:

```ts
import { flow } from '@wular/coder';

const run = await flow.run('fix-tests', { args: { files } });
console.log(run.result, run.tokens);
```

If you need a wave with gates, journaling, and resume, write a [flow](flows.md) instead of hand-rolling it on `task.*`; the flow runtime is exactly this SDK plus those services.

## Errors

`CoderError.code` says what went wrong: `'chain-exhausted'` (every engine failed to start, with the fallback payload and `fallback.instructions`), `'approval-pending'` (the approval to answer), `'login-failed'`, `'server'` (with the HTTP `status` the server answered), and the option errors the CLI reports the same way.

## Runners

`runner.list(options?)` returns `{ items, catalog }`. Each catalog spec describes a kind, its fields and whether this server can offer it. Rows contain a personal or workspace scope, an effective default, presence and non-secret config. Secret fields are sealed in storage and never returned.

Use `runner.add({ kind, name, scope, config }, options?)` to connect an HTTP, GitHub Actions, Vercel Sandbox or local Docker runner. `runner.update(id, { name?, default?, config? }, options?)` updates it, preserving omitted secret fields. `runner.default(id, options?)` makes it the default within its scope. `runner.test(id, options?)` returns `{ ok, detail, ms }` within five seconds, and `runner.remove(id, options?)` removes a record. The built-in server runner cannot be renamed or removed.

`runner.pair({ name?, scope }, options?)` returns a single-use token valid for 15 minutes and a `coder runner serve --url <server> --token <token>` command. Expose the runner port through a tunnel and set `CODER_RUNNER_URL` to that tunnel's HTTPS address, or add `--runner-url <address>`. The pairing fixes the member and workspace that own the resulting HTTP record. The runner generates and saves its own signing secret, calls home every minute, and marks itself offline on shutdown. Serving without a token still registers through the signed-in member's client.

Tasks choose a named runner first, then the agent definition's `runner`, the requester's default, the workspace default and the built-in server default. Explicit names must resolve to a visible record or the built-in ID. Local kinds are available only on a local server, and Docker also requires its executable on PATH. Vercel access-token runners use the server's `VERCEL_PROJECT_ID` and, when no team field is provided, `VERCEL_TEAM_ID` for the SDK's project context.

The matching CLI commands are `coder runner add <kind>`, `list`, `default <id>`, `test <id>` and `remove <id>`. Repeat `--field key=value` when adding a runner. Secret fields use an environment reference such as `--field token=env:GITHUB_TOKEN`. `--scope` accepts `personal` or `workspace`; a workspace record requires an owner or admin. `coder runner add local` prints a pairing command.
