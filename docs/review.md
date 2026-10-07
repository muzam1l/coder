# Review

`coder review` runs one read-only review task over local changes or a pull request, checks every finding against the repository, and prints the ones that hold. With `--post` it comments inline on the pull request and keeps one sticky summary. A local review covers everything since the merge-base with the origin default branch, committed or not, and never touches the index or working tree.

```sh
coder review                         # local changes since the default branch
coder review --base main --path src  # only src, against main
coder review --pr 42 --post          # pull request 42, posted as comments
```

## Flags

| Flag                    | Meaning                                                                                                                          | Default                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `--effort <level>`      | Model reasoning effort and review depth: `low` reports critical and major defects, `medium` any defect, `high` also minor issues | Repository configuration, `medium`                 |
| `--base <ref>`          | Older side of a local diff                                                                                                       | Merge-base of `HEAD` and the origin default branch |
| `--head <ref>`          | Newer side of a local diff, commits only                                                                                         | The working tree                                   |
| `--pr <n \| url>`       | Pull request number in the origin repo, or a GitHub pull request URL                                                             | Local diff                                         |
| `--since <sha>`         | Keep only pull request hunks changed after this commit                                                                           | Head in the previous sticky summary                |
| `--path <p>`            | Review only this pathspec; repeatable                                                                                            | Everything                                         |
| `--exclude <p>`         | Leave this pathspec out; repeatable                                                                                              | Nothing                                            |
| `--post`                | Post inline comments and update the sticky summary; needs `--pr`                                                                 | Print only                                         |
| `--md`                  | Print Markdown                                                                                                                   | Enabled unless `--json` is used                    |
| `--json`                | Print `{ findings, summary, runId }`                                                                                             | Disabled                                           |
| `--engine <name>`       | Engine for the review task                                                                                                       | Repository configuration                           |
| `--model <alias\|slug>` | Model for the review task                                                                                                        | Repository configuration                           |
| `--cwd <dir>`           | Checkout to review                                                                                                               | Current directory                                  |

`--pr` cannot be combined with `--base` or `--head`, and `--json` cannot be combined with `--md`.

## Repository rules

The reviewer reads `AGENTS.md`, `CLAUDE.md`, and an optional `.coder/review.md` from the base commit, so a change cannot rewrite its own rules. Each file is capped at 32,000 characters.

## Submodules

Changed submodules are reviewed file by file under their path. Uninitialized ones, ones missing a needed commit, and nested repositories that are not submodules are skipped with a warning, and submodule findings are never posted inline.

## Exit codes

The command exits `0` when the review completes, even with findings, `1` when the diff, review, or posting fails, `3` when no engine starts, and `4` while a task awaits approval.
