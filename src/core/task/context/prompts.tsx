/** @jsxImportSource contextjsx */
/** Task prompts outside a turn's request: ask, approval review and JSON replies. */
import { Data, render } from 'contextjsx';

import type { Task } from '../../types';

// Read-only ask (core/task/actions).

/** The files a task leaves in its directory. */
export interface TaskFiles {
  log: string;
  result: string;
  worker: string;
}

/** A one-off question about a task, answered from its saved state without touching it. */
export function askPrompt(
  task: Task,
  files: TaskFiles,
  question: string,
  command?: string,
): string {
  const prompt = render(
    <>
      <instructions>
        {[
          'Answer one question about a Coder task, read-only.',
          'You are not the task: never continue, redo or fix its work. The task never sees this question or your answer.',
          'Grep or read the files selectively; events can be large.',
          'Answer directly and concisely.',
        ].join('\n')}
      </instructions>
      <task>
        <Data
          value={{
            id: task.id,
            name: task.name ?? undefined,
            status: task.status,
            engine: task.engine,
            model: task.model ?? undefined,
            effort: task.effort ?? undefined,
            workspace: task.cwd ?? undefined,
            created: task.createdAt ?? undefined,
            finished: task.completedAt ?? undefined,
          }}
        />
      </task>
      <task-prompt>
        <Data>{task.prompt ?? '(unknown)'}</Data>
      </task-prompt>
      <files>
        {[
          `progress log, one JSON event per line: ${files.log}`,
          `final result: ${files.result}`,
          `worker output: ${files.worker}`,
          task.cwd && `workspace with the task's code and changes: ${task.cwd}`,
        ]
          .filter(Boolean)
          .join('\n')}
      </files>
      <question>
        <Data>{question}</Data>
      </question>
    </>,
  );

  return command ? `${prompt}\n\nCoder command ${command}` : prompt;
}

// Approval reviewer (core/engines/claude/sidecar).

/** The reviewer session's first message: its rules, the task's goal and its progress log. */
export function approvalReviewerPrompt(goal: string | null | undefined, log: string): string {
  return render(
    <>
      <rules>
        {[
          'Review actions a Coder task wants to run outside its OS sandbox.',
          'Decline git writes (commit, push, checkout, reset and the like).',
          'Decline commands that print secret values, such as env dumps or CLI config and token output.',
          'Decline destructive or system-level actions: sudo, rm -rf outside the workspace, killing processes, changing system config, piping downloads to a shell.',
          'Temp locations (/tmp, $TMPDIR, OS temp dirs) and paths the task created are workspace scratch; delete them only after checking the progress log.',
          'Accept actions the task goal clearly needs: package installs in the workspace, tests, builds, linters, reading system info, network to well-known package registries.',
          'Escalate when uncertain, when the action is irreversible beyond the workspace, or when it touches credentials or secrets.',
          'Read workspace files or the progress log only when the action line alone is not enough.',
          'Reply with only one line of JSON: {"decision":"accept"|"decline"|"escalate","reason":"<short>"}. Acknowledge now with {"decision":"escalate","reason":"ready"}.',
        ].join('\n')}
      </rules>
      <task-goal>{goal && <Data>{goal.replace(/\s+/g, ' ').slice(0, 500)}</Data>}</task-goal>
      <progress-log>{log}</progress-log>
    </>,
  );
}

/** One action for the reviewer to decide. */
export const approvalActionPrompt = (summary: string) => `action: ${summary.slice(0, 500)}`;

// Structured output (flow/runtime, core/engines/codex/chat-bridge).

/** Asks for the JSON a schema describes, where the engine cannot enforce the schema itself. */
export function jsonReplyPrompt(schema?: unknown): string {
  return schema
    ? `Reply with only one JSON object matching this JSON Schema, without prose or markdown fences:\n${JSON.stringify(schema)}`
    : 'Reply with only one JSON object matching the requested shape, without prose or markdown fences.';
}

/** Asks again after a reply failed validation. */
export const jsonRetryPrompt = (errors: string) =>
  `Your last reply did not match the required JSON: ${errors}\nReply again with only the JSON object.`;
