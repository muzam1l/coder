# SDK

Everything the CLI does, as a library. The SDK mirrors the CLI exactly: every command group is a namespace, every subcommand a function, with the same names and the same options (`coder --help` is the reference for both).

```ts
import coder from '@wular/coder';
// or pick namespaces: import { task, flow, model, config } from '@wular/coder';

const { taskId } = await coder.task.run('Explain this repo', {
  model: 'terra',
});

const res = await coder.task.result(taskId, { wait: true });

console.log(res.result?.finalMessage);
```

SDK functions never print and never call `process.exit`; results come back as typed values and failures as a typed `CoderError` whose `code` says what went wrong. The case the CLI maps to exit code 3 (every engine in the chain failed to start) is `code: 'chain-exhausted'`, carrying the same fallback payload; a task blocked on a permission is `'approval-pending'`, carrying the approval to answer.

## CLI to SDK mapping

| CLI                                                                             | SDK                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coder run "<text>"`                                                            | `task.run(prompt, opts?)`                                                                                                                                                                |
| `coder list`                                                                    | `task.list(opts?)`                                                                                                                                                                       |
| `coder result [id] [--wait] [--tail N]`                                                      | `task.result(id?, { wait?, tail? })`                                                                                                                                                       |
| `coder task steer <id> "<text>"`                                                | `task.steer(id, text)`                                                                                                                                                                   |
| `coder task stop <id>`                                                          | `task.stop(id)`                                                                                                                                                                          |
| `coder task stream [id] [--tail N]`                                                        | `task.stream(id?, { tail? })` - async iterable of progress events                                                                                                                                   |
| `coder task approvals [id]`                                                     | `task.approvals(id?)`                                                                                                                                                                    |
| `coder task approve <id> <appr>`                                                | `task.approve(id, approvalId, { deny? })`                                                                                                                                                |
| `coder task archive / delete <id>`                                              | `task.archive(id)` / `task.delete(id)`                                                                                                                                                   |
| `coder flow run <name>`                                                         | `flow.run(nameOrPath, { args?, concurrency?, maxTasks? })`                                                                                                                               |
| `coder flow list`                                                               | `flow.list()`                                                                                                                                                                            |
| `coder flow discover`                                                           | `flow.discover()`                                                                                                                                                                        |
| `coder flow result [id] [--tail N]`                                                        | `flow.result(id?, { tail? })`                                                                                                                                                                       |
| `coder flow stream [id] [--tail N]`                                                        | `flow.stream(id?, { tail? })`                                                                                                                                                                       |
| `coder flow stop [id]`                                                          | `flow.stop(id?, { keepTasks? })`                                                                                                                                                         |
| `coder flow resume [id]`                                                        | `flow.resume(id?)`                                                                                                                                                                       |
| `coder flow archive / delete <id>`                                              | `flow.archive(id)` / `flow.delete(id)`                                                                                                                                                                       |
| `coder model add / update / remove / list / alias / unalias / disable / enable` | `model.add(name, opts)` / `model.update(...)` / `model.remove(name)` / `model.list()` / `model.alias(name, spec)` / `model.unalias(name)` / `model.disable(name)` / `model.enable(name)` |
| `coder config get / set`                                                        | `config.get(key?)` / `config.set(key, value)`                                                                                                                                            |
| `coder setup-host [hosts...]`                                                   | `setupHost(hosts?)`                                                                                                                                                                      |
| `coder upgrade`                                                                 | `upgrade({ cliOnly?, pluginsOnly? })`                                                                                                                                                    |
| `coder docs [topic]`                                                            | `docs(topic?)`                                                                                                                                                                           |

Options objects take the same names as the CLI flags, camelCased (`--max-tasks` becomes `maxTasks`).

## Examples

Dispatch a wave and wait for all of it:

```js
import { task } from '@wular/coder';

const ids = await Promise.all(
  areas.map(a => task.run(`Audit ${a}`, { permissions: 'read-only' })),
);

const results = await Promise.all(
  ids.map(({ taskId }) => task.result(taskId, { wait: true })),
);
```

Follow a task live:

```ts
for await (const event of task.stream(taskId)) {
  console.log(event.kind, event.text);
}
```

Run a flow from your own tooling:

```ts
import { flow } from '@wular/coder';

const run = await flow.run('fix-tests', { args: { files } });
console.log(run.result, run.tokens);
```

If you need a wave with gates, journaling, and resume, write a [flow](flows.md) instead of hand-rolling it on `task.*`; the flow runtime is exactly this SDK plus those services.
