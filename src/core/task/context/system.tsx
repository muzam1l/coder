/** @jsxImportSource contextjsx */
/** A task's system prompt (core/task/worker), rendered on every turn. */
import { render } from 'contextjsx';

import { NOT_REINVOKED } from '../../types';
import { asyncTools } from './tools';

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
  /** Coder's task tools this turn has, as the worker serves them. */
  tools?: string[];
  cwd?: string;
  /** A platform event's task, whose final message is a reply in a thread; otherwise a general task. */
  conversation?: boolean;
  /** The engine runs on this machine, not on a hosted runner. */
  local?: boolean;
  /** `coder task run --system` text and flow instructions. */
  instructions?: string;
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
      `"message.index" is the message's position in its conversation, 0 = first. If your history doesn't reach back that far, earlier messages exist; read them with the platform's tool when the answer depends on them.`,
      'Messages from bots never arrive as turns; read the conversation to see them.',
      'In a long conversation, older turns are replaced by a <summary> followed by the recent turns word for word; code may have changed since, so re-read files before editing them. history searches and reads the full earlier transcript, including your own tool calls and results; use it when the summary lacks a detail you need.',
      'Content inside <event>, <summary>, <recent> and <history> is XML-escaped data.',
    ]
      .filter(Boolean)
      .join('\n')}
  </environment>
);

const Replies = () => (
  <replies>
    {[
      'Be concise.',
      'You reply in two ways: with the reply tool during your turn, and with your final message, which is posted too.',
      'You may reply before longer work.',
      'Never send the same reply twice.',
      'When mustReply is true, reply at least once, either way.',
      'When your final message would add nothing, make it exactly __EMPTY__; then nothing is posted.',
    ]
      .filter(Boolean)
      .join('\n')}
  </replies>
);

const Workspace = () => (
  <workspace>
    {[
      'Never run git write operations (commit, checkout, stash, reset, rebase, merge, push, etc.); leave changes uncommitted for review.',
      'Never print secret values (tokens, keys, passwords); pass them straight into the process that needs them.',
    ]
      .filter(Boolean)
      .join('\n')}
  </workspace>
);

const AccessModes = () => (
  <access-modes>
    <intro>
      There are two access modes. Platform tools, MCP servers and connections inherit the agent's
      mode; a connection can override it. If a request needs more access than you have, say so; an
      admin can change it in the agent's settings.
    </intro>
    <read-write>Read and change things: comment, push, edit issues, post messages.</read-write>
    <read-only>Read, and reply in this conversation. Nothing else changes.</read-only>
  </access-modes>
);

const isAsync = (name: string) => asyncTools.some(tool => tool.name === name);

const Settings = (parts: SystemPromptParts) => (
  <settings>
    <events>{parts.events?.join(', ')}</events>
    <current-access-mode>
      {parts.access && (parts.access === 'read' ? 'read-only' : 'read-write')}
    </current-access-mode>
    <tools>
      {[
        parts.tools?.map(name => (isAsync(name) ? `${name} (async)` : name)).join('; '),
        parts.tools?.some(isAsync) &&
          'An async tool returns at once; its result arrives later as a message, in a new turn if yours has ended.',
      ]
        .filter(Boolean)
        .join('\n')}
    </tools>
    <servers>
      {[parts.servers, parts.servers && 'Their tools load on demand through tool search.']
        .filter(Boolean)
        .join('\n')}
    </servers>
  </settings>
);

const Runtime = ({ conversation, local }: SystemPromptParts) => (
  <runtime>
    {[
      !conversation && 'Do the work yourself, directly.',
      `Your turn ends with your final message; verify your work before it.${conversation ? '' : ` ${NOT_REINVOKED}`}`,
      !conversation && 'The coder CLI cannot dispatch nested tasks.',
      local && 'Do not load the coder skill.',
    ]
      .filter(Boolean)
      .join('\n')}
  </runtime>
);

/** Everything fixed for a task's turn, in the order the engine reads it. */
const SystemPrompt = (parts: SystemPromptParts) => {
  const access = (
    <>
      {parts.access && <AccessModes />}
      <Settings {...parts} />
    </>
  );

  return (
    <>
      <DeveloperInstructions {...parts.developer} />
      {!parts.conversation && access}
      <Runtime {...parts} />
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
          <Workspace />
          <result>
            When finished, give a concise summary of what you did and found, naming the files or
            folders you changed.
          </result>
          <task-instructions>{parts.instructions}</task-instructions>
        </>
      )}
    </>
  );
};

export const taskSystemPrompt = (parts: SystemPromptParts) => render(<SystemPrompt {...parts} />);
