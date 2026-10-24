---
description: coder review, a read-only review of local changes or a pull request.
---

# Review

`coder review` runs one read-only review task over local changes or a pull request, checks every finding against the repository, and prints the ones that hold. With `--post` it posts one review on the pull request: the reviewer's one-line note and markdown body, followed by a list and footer built by code, and an inline comment for each new finding. A posted finding is never posted again, even after its line moves. A local review covers everything since the merge-base with the origin default branch, committed or not, and never touches the index or working tree.

```sh
coder review                         # local changes since the default branch
coder review --base main --path src  # only src, against main
coder review --pr 42 --post          # pull request 42, posted as comments
```

## Flags

| Flag | Meaning | Default |
| --- | --- | --- |
| `--base <ref>` | Older side of a local diff | Merge-base of `HEAD` and the origin default branch |
| `--head <ref>` | Newer side of a local diff, commits only | The working tree |
| `--pr <n \| url>` | Pull request number in the origin repo, or a GitHub pull request URL | Local diff |
| `--since <sha>` | Keep only pull request hunks changed after this commit | Head of the last posted review |
| `--path <p>` | Review only this pathspec, repeatable | Everything |
| `--exclude <p>` | Leave this pathspec out, repeatable | Nothing |
| `--post` | Post the review on the pull request as the signed-in `gh` user. Needs `--pr` | Print only |
| `--run <id>` | With `--post`, post a finished review run instead of reviewing again | Review now |
| `--md` | Print Markdown | Enabled unless `--json` is used |
| `--json` | Print `{ note, body, findings, summary, pr?, runId }` | Disabled |
| `--model <spec>` | [Model spec](models.md#pick-a-model) for the review task | The workspace's `reviewModel` |
| `--depth <low\|medium\|high>` | What to report: `low` critical and major defects, `medium` any defect a maintainer would act on, `high` also minor issues | `medium` |
| `--cwd <dir>` | Checkout to review | Current directory |

`--pr` cannot be combined with `--base` or `--head`, and `--json` cannot be combined with `--md`.

## Repository rules

The reviewer reads `AGENTS.md`, `CLAUDE.md`, and an optional `.coder/review.md` from the base commit, so a change cannot rewrite its own rules. Each file is capped at 32,000 characters.

## Submodules

Changed submodules are reviewed file by file under their path. Uninitialized ones, ones missing a needed commit, and nested repositories that are not submodules are skipped with a warning. Submodule findings are listed in the posted review with their full path, never inline.

## Exit codes

The command exits `0` when the review completes, even with findings, `1` when the diff, review, or posting fails, `3` when no engine starts, and `4` while a task awaits approval.

## Posted review

One GitHub review per run: the reviewer's note and body, then the findings list headed `Reviewed b34340e: 3 issues` (the compare range on a rerun), each title linked to its inline thread at `file:12` or `file:12-20`. Basic output uses bold severity words and a small Markdown footer linking coder cloud (or coder cli) and the task when present. Inline comments put the bold severity between the title and failure. The CLI and self-hosted servers use basic output, with no images. With nothing found, `Nothing to report.`

Reviews post plain Markdown: bold severity words and a `Posted by` line. A server with `REVIEW_ASSETS` set ([Self-host](self-host.md)) shows themed severity pills and buttons from that path or URL instead. coder.wular.ai sets it to the SVGs its site serves.

- A rerun reviews only commits since the last posted review, and never posts a finding twice. After a force-push it says so.
- The reviewer sees up to 100 earlier findings on the pull request with their state, never reply text. Only a resolved thread settles one.
- Posting stops if the pull request moved since it was read: `The pull request moved to <sha7> since this review. Review again.`
- Model text cannot ping, add HTML, images or links.
- On a Coder server the review also runs a `Coder review` check on the head commit:
  - `success`: clean, with no unresolved earlier findings.
  - `neutral`: findings, earlier findings still unresolved (`no new issues, N unresolved`), or the review itself failed.
  - `skipped`: the head moved. `cancelled`: stopped or timed out.

  Findings never fail the check. Red means the change is broken, not that Coder had an opinion or an outage. Resolve a thread on GitHub to clear it. Any event on a pull request gets the check. It uses a separate checks-only token, and agent tokens never carry Checks. An installation that has not accepted the Checks permission yet gets reviews without the check. The CLI and local reviews post no check.

## Who posts

- A pull request event or any task on a Coder server: the agent's `review` tool. The runner drives it with the agent's app token and the review posts as the app. A `read-only` task posts only on its own event's pull request. The reviewer itself never gets the token.
- The `review` tool of a task on this machine: the findings come back unposted. Posting them as you takes your approval of `coder review --post --run <id>`.
- `coder review --pr <n> --post`: posts as the `gh` user signed in here.

A repository's own `.coder/flows/review.ts` replaces the built-in flow but gets neither the app's token nor the checks token, so it cannot post or set checks as the app.

A reviewer runs as the same OS user as its task, so a read-only sandbox stops writes, not reads: files the task's turn holds, including its git credential, are reachable. Only a machine sandbox or a separate user isolates them.

## From a task

Every task has a `review` tool. It reviews the task's uncommitted changes in the background, or those since `base`, or a pull request, and sends the findings to the task as a message. One review runs at a time, at most 5 per turn.
