---
description: Set up the Coder runtime (install the CLI, verify engines, configure the chain)
model: sonnet
effort: low
---

Set up the Coder runtime for this machine. Work quickly and tersely: run the
shell steps, keep commentary to a line or two, and only expand when something
needs the user's decision. Use AskUserQuestion for the decision points.

1. In one shell call, ensure the runtime then read its status:
   `command -v coder >/dev/null || npm install -g @wular/coder; coder setup --json`
   (codex/claude availability and auth are in the JSON).
2. Codex is the recommended primary engine; Claude (opus subagents in Claude Code) is the fallback. Choose the default from what is installed. Do NOT ask about chain ordering:
   - **Codex installed** (logged in, or logged out; installed still counts): keep the default `codex → claude` chain. If it is logged out, tell the user to run `codex login` themselves, then re-run `coder setup` to confirm.
   - **Codex not installed**: run `coder config set chain claude,codex` so tasks run on Claude opus subagents immediately, tell the user that is the default for now, then ask (AskUserQuestion) whether to install Codex since it is the recommended primary. On yes: `npm install -g @openai/codex`, have them run `codex login`, then `coder config set chain codex,claude`.
3. Show the final config (`coder config`) and mention overrides live in `~/.coder/config.json` (machine) and `coder.config.json` (per repo).
4. Suggest trying it: "Use Coder to <some small task>".

$ARGUMENTS
