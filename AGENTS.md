# Coder: instructions for agents

## Code

- Find where a concern lives and extend that file in its patterns. Search `src/` for an existing helper, type or interface before writing one. New file only for a new concern, named for it, in the folder that owns it. No underscore names, no single-variable files, no files named after a lane or fix.
- Related small operations share one file (`core/task/actions.ts`: steer, ask, list, stop, archive, delete). Don't split under 500 lines; 1000 is fine.
- One blank line between groups of related statements and before the return. A read stays with its guard. Never a blank line after every statement, never a wall.
- No type argument a call can infer; make the API generic over the literal (`store.list("runner")`).
- Cross-cutting behaviour (auth, limits, cookies) runs once in front of the router, declared by a table. Handlers never call it.
- No module-level state. Per-server state lives on the context, store or queue; per-request facts are passed down.
- Comments one line, only for a non-obvious why. Formatting is prettier's (`bun run format`).
- Secrets from the environment only. HTTPS except loopback; `ADMIN_TOKEN` never leaves loopback.

## Layout

- `src/cli.ts` and `src/sdk.ts` are thin: parse, call one core function, print or return. Logic lives in core and its domains (`agent`, `client`, `flow`, `server`, `integrations`).
- `src/cmd/` mirrors the CLI (`cmd/task/stop.ts` is `coder task stop`); `src/tui/` is generic terminal rendering.
- Platform code only under `src/integrations/<platform>/`, reached through `integrations/types.ts` and the catalog `integrations/index.ts`.
- Public SDK mirrors commands; storage, routing, runners and HTTP client stay internal. `server.handler(env)` is the one hosting primitive.
- Dashboard imports: `@/` inside `src/server/dash`, `@coder/` for the rest. Never `../../..`.
- One migration until launch, `migrations/0000_initial.sql`, from `drizzle-kit generate`; dev databases use `drizzle-kit push`.

## Gate

- CLI tests in `../tests/<domain>/` (agent/cli/core/flow, with TUI in cli/tui), server tests in `../tests/server/` by topic, named for the behaviour; a fix starts red.
- Help specs in `src/cmd/`, `src/tui/help.ts`, `docs/` and the CLI change together.
- `bun test` in `../tests`, `npx tsc -p tsconfig.json --noEmit`, `bun run build`.
