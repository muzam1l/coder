# Flows

Orchestrate many coder tasks with a plain TypeScript file. A flow is code, not config: loops, conditionals, and nesting are just JavaScript, while dispatch, concurrency, journaling, and resume come from the runtime. Every task a flow spawns is a regular coder task, so `coder list`, `coder task steer`, and `coder task stop` work on them like any other.

Like tasks, flows are normally authored by your host agent: you describe the wave, the harness writes the flow file into `.coder/flows/`, and you review or edit it before it runs. The file is the contract; everything below is what goes in it.

## A first flow

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

Run it:

```bash
coder flow run audit-routes --wait
```

`--wait` streams the run's progress right there; without it the run goes to the background and `coder flow stream` shows the same lines any time. If the run dies mid-wave, `coder flow resume` continues it without re-running finished steps.

## Flows are plain modules

A flow is an ordinary TypeScript module: import the primitives, use top-level `await`, and `export default` the result. Input comes in through the `args` import (see [`args`](#args)):

```ts
// .coder/flows/verify-wave.ts
import { task, pipeline, args } from '@wular/coder/flow';

export default await pipeline(args.clusters as string[], c =>
  task(`Verify cluster ${c}.`),
);
```

## The primitives

### `task(prompt, opts?)`

Dispatch one coder task and await its result.

```ts
const r = await task('Explain the auth module', {
  model: 'terra',
  permissions: 'read-only',
});
r.output; // final message text
```

Options are the same as the `coder run` flags (`agent`, `model`, `effort`, `permissions`, `name`, `system`, `resume`, `cwd` - see `coder run --help`), plus one of its own:

- `returns` - a zod schema for structured output instead of prose. The runtime injects the format instructions, validates the reply (one corrective retry on mismatch), and the parsed value lands on `r.data`:

```ts
const r = await task(
  'List every file that imports the legacy cache API.',
  {
    returns: z.object({ files: z.array(z.string()) }),
  },
);

r.data.files; // string[], validated
```

Returns `{ taskId, status, output, data?, tokens, model }`. If the task fails, `task()` throws; catch the error to inspect the failed result or retry.

> Note: unlike the SDK's `task.run()`, which returns a task id right away and leaves waiting to you, the flow `task()` waits for the result in one call, and inside a run it is journaled and concurrency-limited.

### `gate(cmd, opts?)`

A deterministic shell checkpoint. Gates are never agents: they run the command and return `{ ok, code, output }`. A failing gate does not throw, because a failed gate is a decision point, not an error:

```ts
const g = await gate('bun tsc');
if (!g.ok) {
  // retry with g.output in the prompt, park the item, or bail - your call
}
```

The command runs through the shell, so treat it like any shell string: never interpolate task output (or other model-derived text) into it - `gate(`test -n "${r.output}"`)` hands the model shell access. Write fixed commands, or pass model output through a file/env var the command reads.

### `pipeline(items, ...stages)`

The workhorse. Give it a list of items and one or more stage functions; every item moves through the stages independently, as fast as its own work finishes.

```ts
const results = await pipeline(
  files, // items
  file => task(`Fix the tests in ${file}.`), // stage 1
  (r, file) => gate(`bun test ${file}`), // stage 2
);
```

How to read it:

- Stage 1 runs for each file (up to the concurrency limit). The moment `a.ts` finishes stage 1, it enters stage 2, even if `b.ts` is still in stage 1. There is no waiting for the whole batch between stages.
- Each stage receives `(previousStageResult, originalItem, index)`, so later stages always know which item they are working on.
- `results` is one entry per item: whatever the last stage returned for it.
- If a stage throws for an item, that item becomes `null` in the results and skips its remaining stages; the other items are unaffected.

Prefer `pipeline` for anything multi-stage: fast items never wait for slow ones.

Use `Promise.all` for plain parallel batches:

```ts
const findings = await Promise.all(
  areas.map(area => task(`Audit ${area}.`)),
);
```

### `args`

The flow's input, from `--args '<json>'` or bare `key=value` pairs:

```ts
import { args } from '@wular/coder/flow';

const items = (args.items ?? []) as string[];
```

Properties are typed `unknown` - assert or default them as you go, or use the function form below for real types.

To validate and type the input with zod, shape the flow as two exports:

- `export const args` - a zod schema for the input
- `export default` - an async function holding the flow body

The runtime checks the input against the schema first, and only if it passes runs the default function, passing the parsed input as its parameter. (Top-level flows can't get this fail-fast check: importing one already executes it.)

```ts
export const args = z.object({ clusters: z.array(z.string()) });

export default async ({ clusters }: z.infer<typeof args>) => {
  // clusters is string[], validated before any task dispatched
};
```

### `flow(name, args?)`

Run another flow inline and get its result:

```ts
const verified = await flow('verify-wave', { clusters });
```

The name resolves like `coder flow run <name>` does (see [Where flows live](#where-flows-live)). Sub-flows share the parent's journal, concurrency, and ledger, and nesting is one level deep: a sub-flow calling `flow()` throws.

### `log(msg)`

Emit a progress line, shown in the flow log and `coder flow stream`:

```ts
log(`${parked.length} clusters parked`);
```

## Concurrency and ceilings

Two knobs, sensible defaults, mentioned together because they scale off the same number:

- **`--concurrency`** - tasks running at once. Defaults to the machine's CPU count. Tasks are engine subprocesses doing mostly network waiting, so this is about engine quota and machine load, not about a flow "using up" your cores.
- **`--max-tasks`** - total tasks one run may dispatch, a backstop against runaway loops. Defaults to CPU count x 10.

Token usage is recorded per model in the run's ledger and shown by `coder flow result`. Bookkeeping, not enforcement.

## Resume

Every `task`, `gate`, and `flow` call is recorded in the run's journal along with a fingerprint of its inputs (the prompt or command, plus options).

`coder flow resume <run-id>` simply imports the module again, fresh, and lets it execute top to bottom. Each call is checked against the journal in order:

1. Inputs identical to last time? Return the recorded result instantly; nothing is dispatched.
2. First call whose inputs differ (or that is new)? It runs for real, and so does everything after it.

What that means in practice:

- **Crash mid-wave** (quota, network, closed laptop): resume replays the finished steps from the journal in milliseconds and continues from where it stopped.
- **Edit step 3, resume**: steps 1-2 replay from the journal, step 3 onward runs fresh. Iterating on a half-broken flow costs only the part you changed.
- **Nothing changed**: the whole run replays from the journal and just returns its result again.

The one rule this buys: **a flow must produce the same prompts on every run**. Do not build prompts from `Date.now()`, `Math.random()`, or unordered directory listings; pass timestamps and seeds in via `--args`. A prompt that differs between runs looks like an edit, and everything after it re-runs.

## Where flows live

`coder flow run <name>` (and `flow(name)` inside a flow) looks for `<name>.ts` or `<name>.mjs` in:

1. `.coder/flows/` walking up from the current directory to the repo root, nearest first. In a monorepo, a flow in `packages/app/.coder/flows/` wins over one at the root when you run from inside `packages/app`.
2. `~/.coder/flows/` - global flows, available in every workspace.

An explicit path (`coder flow run ./scratch/one-off.ts`) bypasses discovery entirely. `coder flow discover` shows every flow discoverable from where you stand.

## CLI

```bash
coder flow run <name|path> [--wait] [--args '<json>' | key=value...]
    [--concurrency N] [--max-tasks N] [--json] [--dry-run]
coder flow list                 # recent runs: id, name, status, tasks, tokens, age
coder flow discover             # flows runnable here: workspace + global
coder flow result [run-id]      # progress and result: tasks, gates, token ledger
                                #   --tail <n|all>: last n step rows (default all; 0 = final result only)
coder flow stream [run-id]      # replay the progress lines and keep following live
                                #   --tail <n|all>: replay the last n events (default all)
coder flow stop [run-id]        # stop a run and its tasks (--keep-tasks to let them finish)
coder flow resume [run-id]      # continue a stopped or edited run; same flags as run
coder flow archive <run-id>     # hide a run from the recent list (or --all-stopped)
coder flow delete <run-id>      # delete a run's record (or --all-archived)
```

Runs show up in `coder list` alongside tasks, with the run's tasks grouped under it. Any `[run-id]` defaults to the most recent run.

`coder flow run` prints the run id and orchestrates in the background. `--wait` follows the run in the foreground, rendering progress live as tasks start and finish; Ctrl-C detaches and the run keeps going, just like a task. `coder flow stop` is the only way to end a run: it stops the orchestrator and the tasks it still has running (pass `--keep-tasks` to let those finish), leaving the journal ready for `resume`. A finished run's result (the flow's default export) is shown by `coder flow result`.

`--dry-run` executes the script with dispatch stubbed out: it prints every resolved prompt and gate command with placeholder results, so you can review exactly what would be sent before spending tokens.

## SDK

Flows sit on top of the coder SDK, and the SDK is public: everything the CLI does, your own code can do, including running flows programmatically. See [SDK](sdk.md).

## Design notes

- **Gates are shell, not agents.** Verification must be deterministic and cheap. An agent judging "did tsc pass" is slower, costlier, and occasionally wrong.
- **Park, don't die.** A failed item should not kill the wave. Return it as data, keep the rest flowing, fix it manually or in the next run.
- **Saturation beats phases.** Prefer `pipeline` so fast items never wait for slow ones; reach for `Promise.all` barriers only when a step truly needs all prior results.
- **The flow executes; you decide.** Keep judgment (what to fix next, whether a spec is ready) in your session, and let flows run the wave you already designed. A flow that invents its own plan mid-run is a flow you cannot review with `--dry-run`.
