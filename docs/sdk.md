---
description: The @wular/coder SDK, every CLI command as a typed function.
---

# SDK

The SDK is the CLI as a library: the same commands, names and options. `coder --help` is the reference for both.

## Rules

- **Names.** A command group is a namespace and a subcommand a function: `coder task steer` is `task.steer`, `coder model alias` is `model.alias`. Top-level commands are functions: `setupHost`, `upgrade`, `docs`. Exceptions:
  - `task watch` is `task.stream`, an async iterable of progress events.
  - `connection rm` is `connection.remove`.
  - `review` is `review.run`.
  - `server rotate-key` is `server.rotateKey`.
  - `agent run --task` is `agent.runTask`, for runners, not application code.
- **Arguments.** Positional arguments come first, in CLI order. Flags become one options object in camelCase: `--max-tasks` is `maxTasks`, `--output-schema` is `outputSchema`.
- **Models.** `model` takes the same spec as `--model`: `sol`, `sol/low`, `claude/opus` or `codex/gpt-6.1-sol/high`.
- **Server.** Every command that takes `--server` accepts `{ server: true | url, organization?, token?, yes? }`:
  - `server` falls back to `CODER_SERVER`, then the hosted service.
  - `organization` is the workspace slug and overrides the saved one.
  - Authentication comes from `auth.login()` or `token`.
  - `yes: true` accepts a new server origin in non-interactive code.
- **Results.** Functions never print and never call `process.exit`. Results are typed values. `task.list` returns one page, `{ items, next? }`; pass `next` back as `cursor`.
- **Errors.** Failures throw `CoderError`, whose `code` says what went wrong:
  - `'chain-exhausted'`: every engine failed to start. It carries the fallback payload and `fallback.instructions`, and is the CLI's exit code 3.
  - `'approval-pending'`: carries the approval to answer.
  - `'login-failed'`.
  - `'server'`: carries the HTTP `status`.
  - The option errors the CLI reports.
- **Hosting.** `server.handler(env)` serves Coder on serverless hosts; see [Self-host](self-host.md#deploy).

## Examples

A task with a JSON answer, then its result:

```ts
import coder from '@wular/coder';

const { taskId } = await coder.task.run('List the API routes', {
  model: 'claude/opus',
  outputSchema: { type: 'object', properties: { routes: { type: 'array' } } },
});
const res = await coder.task.result(taskId, { wait: true });
```

The schema goes to the engine natively and never into the stored prompt. A continuation keeps it unless given a new one.

A wave of read-only tasks:

```ts
import { task } from '@wular/coder';

const ids = await Promise.all(areas.map(a => task.run(`Audit ${a}`, { access: 'read-only' })));
const results = await Promise.all(ids.map(({ taskId }) => task.result(taskId, { wait: true })));
```

Following a task live. Each event has a `kind`, such as `assistant`, `tool`, `usage` or `error`:

```ts
for await (const event of task.stream(taskId)) {
  if (event.kind === 'assistant') console.log(event.message);
}
```

A task on the Coder server:

```ts
await task.steer(id, 'Also cover the retry path', { server: true });
```

A flow:

```ts
import { flow } from '@wular/coder';

const run = await flow.run('fix-tests', { args: { files } });
```

For gates, journaling and resume, write a [flow](flows.md) instead of looping over `task.*`. Runners are in [Runners](runners.md).
