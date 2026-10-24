/** @jsxImportSource contextjsx */
/** A task's system prompt (core/task/worker), rendered on every turn. */
import { render } from 'contextjsx';

import { NOT_REINVOKED, type Access } from '../../types';

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
  /** The agent's access. */
  access?: Access;
}

export interface SystemPromptParts extends AgentPromptParts {
  cwd?: string;
  /** A platform event's task, whose final message is a reply in a thread; otherwise a general task. */
  conversation?: boolean;
  /** The engine runs on this machine, not on a hosted runner. */
  local?: boolean;
  /** The task's scratch folder on the machine it runs on. */
  scratch?: string;
  /** Sandboxed commands reach only the hosts they declare (Claude auto). */
  declareHosts?: boolean;
  /** The task may write (auto). */
  writes?: boolean;
  /** `coder task run --append-system` text and flow instructions. */
  appendSystem?: string;
  /** The final message is JSON for a schema, not a summary. */
  structured?: boolean;
  /** The turn has platform servers, which act as the app or as the person asking. */
  connections?: boolean;
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
      'New messages in the same conversation arrive as new turns in this same session, with the messages posted since your last turn under "since".',
      "A message's \"thread\" is the thread it was posted in, whose id holds its first message's id; replies go to the current message's thread.",
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
      'Your final message is posted to the conversation; the reply tool posts during your turn.',
      'You may reply before longer work.',
      'Never send the same reply twice.',
      'Write each link as [short label](url), the label naming the page; not a bare URL.',
      'When mustReply is true, reply at least once.',
      'When your final message would add nothing, make it exactly "__EMPTY__" with no quotes, then nothing is posted.',
    ]
      .filter(Boolean)
      .join('\n')}
  </replies>
);

const Workspace = ({ scratch, writes }: SystemPromptParts) => (
  <workspace>
    {[
      writes &&
        'Leave changes in the checkout uncommitted. Its diff is reported when the turn ends. Do not commit, switch branches or push in the current workspace or elsewhere except scratch folder if provided.',
      scratch &&
        writes &&
        `Scratch folder is provided for clones, git writes and anything else, deleted with the task: ${scratch}`,
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

const ACCESS: Record<Access, string> = {
  'read-only': 'This task is read-only and uses only tools marked read-only.',
  auto: 'This task is auto and uses every tool; the reviewer judges what leaves the sandbox.',
};

/** Whose identity each connection acts as; the tool search shows each server's scope. */
const Scopes = () => (
  <scopes>
    Each connection in the tool search is workspace or personal, shown after its name.
    <scope name="workspace">
      Acts as the workspace's own identity: on a platform, this agent's installed app or bot; on an
      MCP server, the account an admin connected it with. The default.
    </scope>
    <scope name="personal">
      Acts as the member who owns it, offered on their turns only. Its first use in a task asks them
      to approve.
    </scope>
    Use a personal server only to act as the person or for what only their account reaches, such as
    Slack search. With none for that platform, never use the workspace server as them; give them the
    connection/add link. More: load_skill connections.
  </scopes>
);

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

/** A conversation task's own sections. */
const Conversation = (parts: SystemPromptParts) => (
  <>
    <Environment />
    <Replies />
    {parts.platform && <platform name={parts.platform.name}>{parts.platform.prompt}</platform>}
  </>
);

/** Any other task's own sections. */
const Task = (parts: SystemPromptParts) => (
  <>
    <Workspace {...parts} />
    {!parts.structured && (
      <result>
        When finished, give a concise summary of what you did and found, naming the files or folders
        you changed.
      </result>
    )}
    <task-instructions>{parts.appendSystem}</task-instructions>
  </>
);

/** The parts every task shares, then its kind's own. */
const SystemPrompt = (parts: SystemPromptParts) => (
  <>
    <DeveloperInstructions {...parts.developer} />
    <Runtime {...parts} />
    <Machine {...parts} />
    <access>{parts.access && ACCESS[parts.access]}</access>
    {parts.connections && <Scopes />}
    {parts.conversation ? <Conversation {...parts} /> : <Task {...parts} />}
  </>
);

export const taskSystemPrompt = (parts: SystemPromptParts) => render(<SystemPrompt {...parts} />);
