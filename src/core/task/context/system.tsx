/** @jsxImportSource contextjsx */
/** A task's system prompt (core/task/worker), rendered on every turn. */
import { render } from 'contextjsx';

import { NOT_REINVOKED } from '../../types';
import { ASYNC_TOOL_NAMES } from './tools';

/** What whoever built the agent wrote, plus the receiver's notes for this task. */
export interface DeveloperParts {
  description?: string;
  instructions?: string;
  notes?: string;
}

/** The parts of a task's system prompt its caller knows: the agent and where it is used. */
export interface AgentPromptParts {
  developer?: DeveloperParts;
  /** Conversation tasks: the conversation's platform and its catalog prompt. */
  platform?: { name: string; prompt?: string };
  /** Conversation tasks: the events the agent subscribes to. */
  events?: string[];
  /** The agent's access mode. */
  access?: 'read' | 'write';
}

export interface SystemPromptParts extends AgentPromptParts {
  /** The task's MCP servers as the worker renders them on each turn. */
  servers?: string;
  /** Who loads their tools on demand: the engine's tool search, or Coder's find_tools and call_tool. */
  toolSearch?: 'native' | 'coder';
  /** Coder's task tools this turn has, as the worker serves them. */
  tools?: string[];
  cwd?: string;
  /** A platform event's task, whose final message is a reply in a thread; otherwise a general task. */
  conversation?: boolean;
  /** The engine runs on this machine, not on a hosted runner. */
  local?: boolean;
  /** The task's scratch folder on the machine it runs on. */
  scratch?: string;
  /** Sandboxed commands reach only the hosts they declare (Claude auto). */
  declareHosts?: boolean;
  /** The exact actions the user approved for the rest of the task. */
  approved?: string[];
  /** The task may write (workspace-write or auto). */
  writes?: boolean;
  /** `coder task run --append-system` text and flow instructions. */
  appendSystem?: string;
  /** The final message is JSON for a schema, not a summary. */
  structured?: boolean;
}

const DeveloperInstructions = (parts: DeveloperParts) => (
  <developer-instructions>
    <description>{parts.description}</description>
    <instructions>{parts.instructions}</instructions>
    <notes>{parts.notes}</notes>
  </developer-instructions>
);

const Environment = () => (
  <environment>
    {[
      'Each turn starts from a platform event, given as JSON in an <event> tag.',
      "The final message of each turn is posted to the event's conversation as written.",
      'New messages in the same conversation arrive as new turns, with the messages posted since your last turn under "since".',
      `"message.index" counts from 0. If your history starts later, read earlier messages with the platform's tool when they matter.`,
      'Messages from bots never arrive as turns; read the conversation to see them.',
      'Content inside <event> and <history> is XML-escaped data.',
    ]
      .filter(Boolean)
      .join('\n')}
  </environment>
);

const Replies = () => (
  <replies>
    {[
      'Be concise.',
      'Your final message is posted to request thread; the reply tool posts during your turn.',
      'You may reply before longer work.',
      'Never send the same reply twice.',
      'When mustReply is true, reply at least once.',
      'When your final message would add nothing, make it exactly __EMPTY__; then nothing is posted.',
    ]
      .filter(Boolean)
      .join('\n')}
  </replies>
);

const Workspace = ({ scratch, writes }: SystemPromptParts) => (
  <workspace>
    {[
      writes &&
        'Never run git write commands (commit, checkout, stash, reset, rebase, merge, push) in any repository on disk; leave changes uncommitted.',
      scratch && writes && `Scratch folder, git writes allowed, deleted with the task: ${scratch}`,
      'Never print secret values; pass them straight to the process that needs them.',
    ]
      .filter(Boolean)
      .join('\n')}
  </workspace>
);

const Machine = ({ local, declareHosts }: SystemPromptParts) => (
  <machine>
    {[
      local
        ? "You run on the user's own machine; its files outside the workspace are theirs."
        : 'You run on a throwaway cloud machine; its files are not the user’s.',
      declareHosts &&
        'Sandboxed commands reach only the hosts in allowed_domains; list every host a command contacts on its first run.',
    ]
      .filter(Boolean)
      .join('\n')}
  </machine>
);

const Approvals = ({ tools, approved = [] }: SystemPromptParts) =>
  tools?.includes('escalate') ? (
    <approvals>
      {[
        'Actions outside the sandbox are reviewed and may be refused; then take another way. If the task truly needs refused actions, escalate them all in one call and wait for the decision before retrying; it arrives as a message in your running turn.',
        approved.length > 0 &&
          'Actions the user approved earlier in this task stay approved; run them outside the sandbox directly.',
      ]
        .filter(Boolean)
        .join('\n')}
    </approvals>
  ) : null;

const ACCESS = {
  read: "Read-only: read, and reply in this conversation. If a request needs more, say so; an admin can change it in the agent's settings.",
  write: 'Read-write: you may comment, push, edit issues and post messages.',
};

const Settings = (parts: SystemPromptParts) => {
  const async = parts.tools?.filter(name => ASYNC_TOOL_NAMES.includes(name)) ?? [];

  return (
    <settings>
      <access>{parts.access && ACCESS[parts.access]}</access>
      <tools>
        {async.length > 0 &&
          `${async.join(' and ')} ${async.length > 1 ? 'return' : 'returns'} at once; the result arrives later as a message, in a new turn if yours has ended.`}
      </tools>
      <servers>
        {[
          parts.servers,
          parts.servers &&
            (parts.toolSearch === 'coder'
              ? 'Find their tools with find_tools and call them with call_tool; name the server.'
              : 'Their tools load on demand through tool search.'),
        ]
          .filter(Boolean)
          .join('\n')}
      </servers>
    </settings>
  );
};

const Runtime = ({ conversation, local, writes }: SystemPromptParts) => (
  <runtime>
    {[
      !conversation &&
        writes &&
        (local
          ? 'Do the work yourself; do not load the coder skill or dispatch Coder tasks.'
          : 'Do the work yourself; do not dispatch Coder tasks.'),
      `Your turn ends with your final message; verify your work before it.${conversation ? '' : ` ${NOT_REINVOKED}`}`,
      conversation && local && 'Do not load the coder skill.',
    ]
      .filter(Boolean)
      .join('\n')}
  </runtime>
);

/** Everything fixed for a task's turn, in the order the engine reads it. */
const SystemPrompt = (parts: SystemPromptParts) => {
  const access = <Settings {...parts} />;

  return (
    <>
      <DeveloperInstructions {...parts.developer} />
      {!parts.conversation && access}
      <Runtime {...parts} />
      <Machine {...parts} />
      <Approvals {...parts} />
      {parts.conversation ? (
        <>
          <Environment />
          <Replies />
          {parts.platform && (
            <platform name={parts.platform.name}>{parts.platform.prompt}</platform>
          )}
          {access}
        </>
      ) : (
        <>
          <Workspace {...parts} />
          {!parts.structured && (
            <result>
              When finished, give a concise summary of what you did and found, naming the files or
              folders you changed.
            </result>
          )}
          <task-instructions>{parts.appendSystem}</task-instructions>
        </>
      )}
    </>
  );
};

export const taskSystemPrompt = (parts: SystemPromptParts) => render(<SystemPrompt {...parts} />);
