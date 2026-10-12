# The `coder` agent

The built-in agent. On the hosted service it has an install link per platform; self-hosters create its shared apps once per server with `coder server app create <integration>` ([Self-hosting](../self-host.md#after-the-first-start)). Tune or disable it under `agents.coder` in `.coder/config.json` ([Usage](index.md#usage)).

## On GitHub

- A pull request opening, updating, or becoming ready runs the [review flow](../review.md) read-only and posts inline comments with a sticky summary. Reruns update the summary and never repeat a finding.
- A review request for the agent does the same.
- A mention (`@<app>` from a repository owner or member) answers from the diff and the repository, or makes the requested change on a branch and links the pull request.
- An issue opening or edit reads the issue and the repository, then answers, makes the change and links the pull request, or asks one clarifying question.
- An issue or pull-request comment that says "coder" does the same as a mention.

## On Slack

- A mention, a direct message, or a message that says "coder" reads the thread and the linked repository, then answers, makes the change and links the pull request, or asks one clarifying question.
- Slash commands and reactions wake it too.
- Replies stay in the thread they were asked in, in Slack's style, with short paragraphs and code spans and no headings.
- When the workspace has connected GitHub from the [dashboard](../dash.md), it can read and change code there.

## On Gmail

- An email under the watched label, from a sender whose domain passes DMARC, gets an answer by reply.

## On Linear

- Mentioning or assigning the agent starts a session that answers, or makes the change and links the pull request.

## What it runs with

|             |                                                                   |
| ----------- | ----------------------------------------------------------------- |
| Permissions | `workspace-write`; `read-only` for pull-request reviews           |
| Tools       | GitHub `write`; Slack, Gmail and Linear `comment`          |
| Flows       | `review`                                                          |
| Engine      | the workspace's default [credential](../self-host.md#credentials) |

The definition is `src/agent/builtin/coder/{agent.json,system.md}` in the package; a custom agent is the same two files in your repo ([Your own agents](index.md#your-own-agents)).
