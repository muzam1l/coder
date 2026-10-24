---
description: Flows, TypeScript files that run many coder tasks with gates and resume.
---

# Flows

A flow is a plain TypeScript file that runs many coder tasks. Loops, conditionals and nesting are JavaScript; dispatch, concurrency, journaling and resume come from the runtime. Each task it starts is a regular task, so `coder list`, `coder task steer` and `coder task stop` work on it. A host agent usually writes the flow into `.coder/flows/` from a description, and a person reviews it before it runs.

```ts
// .coder/flows/audit-routes.ts
import { z } from 'zod';
import { task, pipeline } from '@wular/coder/flow';

const routes = await task('List every .ts file under src/routes/.', {
  returns: z.object({ files: z.array(z.string()) }),
});

export default await pipeline(routes.data.files, file =>
  task(`Audit ${file} for missing authentication checks.`, { name: file }),
);
```

`coder flow run audit-routes --wait` runs it and streams progress. Without `--wait` it runs in the background and `coder flow stream` follows it. `/flow <name>` in **# Tasks → [New task]** runs one from the dashboard.

A flow is an ES module with top-level `await`, and its default export is the result. `@wular/coder/flow` and `zod` come with Coder.

## Primitives

- **`task(prompt, opts?)`:** runs one task and waits for it.
  - Options are the `coder run` flags (`model`, `access`, `name`, `appendSystem`, `cwd`, `addDirs`), plus `returns`: a zod schema for structured output, validated with one corrective retry, landing on `r.data`.
  - Returns `{ taskId, status, output, data?, tokens, model }`, and throws if the task fails.
  - Unlike the SDK's `task.run()`, it waits, and inside a run it's journaled and concurrency-limited.
- **`steer(taskId, text, opts?)`:** one more turn on a task this run started, like `coder task steer --wait`. It returns the same shape as `task()` without `data`.
- **`gate(cmd, opts?)`:** a shell checkpoint returning `{ ok, code, output }`. A failing gate doesn't throw; it's a decision point. Never interpolate model output into `cmd`, because that hands the model a shell. Pass it through a file or environment variable instead.
- **`pipeline(items, ...stages)`:** moves each item through the stages independently.
  - An item enters the next stage as soon as it finishes the last one, without waiting for the batch.
  - Each stage gets `(previous, item, index)`.
  - The result is the last stage's value per item, or `null` for an item whose stage threw.
  - Use `Promise.all` for one plain parallel batch.
- **`args`:** the input, from `--args '<json>'` or `key=value` pairs, typed `unknown`. For a validated, typed input, export a zod schema as `args` and a default async function that receives the parsed value. The runtime checks the input before any task starts.
- **`flow(name, args?)`:** runs another flow inline, sharing the journal, concurrency and ledger. Nesting is one level deep.
- **`log(msg)`:** a progress line in the flow log and `coder flow stream`.

## Limits

- `--concurrency`: tasks at once. Defaults to the machine's CPU count.
- `--max-tasks`: total tasks per run, a backstop against loops. Defaults to CPU count × 10.

Tokens per model go to the run's ledger, shown by `coder flow result`.

## Resume

Every `task`, `gate` and `flow` call is journaled with a fingerprint of its inputs. `coder flow resume <run-id>` runs the module again from the top:
- Calls with the same inputs return their recorded results at once.
- The first changed or new call, and everything after it, runs for real.

So a crash resumes where it stopped, and an edit to step 3 re-runs from step 3. A flow must build the same prompts on every run: no `Date.now()`, `Math.random()` or unordered directory listings in prompts; pass those in with `--args`.

## Where flows live

`coder flow run <name>` and `flow(name)` look for `<name>.ts` or `<name>.mjs` in:
1. `.coder/flows/`, from the current directory up to the repo root, nearest first.
2. `~/.coder/flows/`, in every workspace.
3. Built-in flows, which a repo flow of the same name overrides.

A path runs that file directly. `coder flow discover` lists what's runnable here. The built-in `review` is the `coder review` code review. It takes `pr`, `post`, `base`, `head`, `since`, `model` and `depth` and returns `{ note, body, findings, summary, pr? }`. Posting happens inside the flow; server tasks use the `review` tool instead of running this flow by name.

## Running

- `--dry-run` executes the flow with dispatch stubbed and prints every resolved prompt and gate command.
- `--wait` follows in the foreground; Ctrl-C detaches and the run continues.
- `coder flow stop` is the only way to end a run. It stops its running tasks too (`--keep-tasks` lets them finish) and keeps the journal for `resume`.
- Runs appear in `coder list` with their tasks grouped under them.

All commands: [`coder flow`](cli/flow.md). From code: the [SDK](sdk.md).

## Guidance

- **Gates are shell, not agents:** verification stays deterministic and cheap.
- **Park, don't die:** return a failed item as data and keep the wave going.
- **Prefer `pipeline`:** fast items never wait for slow ones.
- **Judgment stays in the session:** a flow runs the wave already designed. A flow that plans mid-run can't be reviewed with `--dry-run`.
