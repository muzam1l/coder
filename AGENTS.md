# Coder: instructions for agents

## Code

- Standard, plain code: the usual names and idioms of the domain and of TypeScript, explicit parameters. No clever constructs (Proxies, sentinels, metaprogramming, coined words) unless a measured hot path needs one.
- One blank line between groups of related statements and before the return. A read stays with its guard. Never a blank line after every statement, never a wall.
- No type argument a call can infer; make the API generic over the literal (`store.list("runner")`).
- No module-level state. Per-server state lives on the context, store or queue; per-request facts are passed down.
- A file opens with one concise comment only when there is something its name doesn't say: its purpose, and especially its conventions.
- Comments one line, only for a non-obvious why. Formatting is prettier's (`bun run format`).
- Secrets from the environment only. HTTPS except loopback; `ADMIN_TOKEN` never leaves loopback.
- Update databases with `drizzle-kit push` as a deploy step; never apply or check schema at server boot or on runners.

## Layout

- Find where a concern lives and extend that file in its patterns. Search `src/` for an existing helper, type or interface before writing one. New file only for a new concern, named for it, in the folder that owns it. No underscore names, no single-variable files, no files named after a lane or fix.
- A feature that could move to a library or be dropped (tool search) is one self-contained module behind a narrow interface.
- `agent/` is agent-only: definitions, events, platform tools and conversations. What every task uses (its prompts, tools, review) lives in `core/task/`.
- Related small operations share one file (`core/task/actions.ts`: steer, ask, list, stop, archive, delete). Don't split under 1000 lines for the sake of it; 2000 is the limit except where more makes it simple like a parser file etc.
- `src/cli.ts` and `src/sdk.ts` are thin: parse, call one core function, print or return. Logic lives in core and its domains (`agent`, `client`, `flow`, `server`, `integrations`).
- Folder and feature entry points (`index.ts`) stay simple and concise: the public surface and its wiring only; the implementation lives in the concern files beside them.
- `src/cmd/` mirrors the CLI (`cmd/task/stop.ts` is `coder task stop`); `src/tui/` is generic terminal rendering.
- Each command is one contextjsx definition in `src/cmd/`; help, `docs/cli/`, the host skills and `coder mcp` come from it.
- A `context/` folder holds only what a model reads: `tools.ts(x)` the tool definitions, `system.tsx` the system prompt tree, `turn.tsx` the turn prompt tree, `index.ts(x)` the `defineApp` that joins them. Runtime code (MCP clients, server launch specs, env parsing, search matching) lives with its caller outside `context/`.
- Platform code only under `src/integrations/<platform>/`, reached through `integrations/types.ts` and the catalog `integrations/index.ts`. Each platform has the same files: `index.ts` the integration object, `events.ts` inbound (Chat SDK adapter, webhook check, payload to event), `api.ts` outbound (platform calls, tool presets, MCP server), `app.ts` setup (manifest, install, OAuth); platform-only UI gets its own file (`slack/views.ts`).
- Public SDK mirrors commands; storage, routing, runners and HTTP client stay internal. `server.handler(env)` is the one hosting primitive.
- Dashboard imports: `@/` inside `src/server/dash`, `@coder/` for the rest. Never `../../..`.

## Gate

- CLI tests in private repo coder-workspace (local ../) `coder-workspace/` (agent/cli/core/flow, with TUI in cli/tui), server tests in `coder-workspace/tests/server/` by topic, named for the behaviour; a fix starts red.
- `bun run emit` rewrites `docs/cli/` and the skills; commit them.
- `bun test` in `coder-workspace/tests`, `npx tsc -p tsconfig.json --noEmit`, `bun run build`.
