/** @jsxImportSource contextjsx */
/** A task's system prompt (core/task/worker), rendered on every turn. */
import { render } from 'contextjsx';

import { NOT_REINVOKED, type Access, type McpServerSpec } from '../../types';
import { TOOL_SEARCH_PROMPT } from '../../tool-search';
import { handoffLink } from '../../tools';
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
  /** The agent's access. */
  access?: Access;
  /** The agent's platforms; `personal` when a person connects their own account, else admins install it. */
  platforms?: Array<{ id: string; name: string; personal?: boolean }>;
}

export interface SystemPromptParts extends AgentPromptParts {
  /** The task's own MCP servers this turn, listed by what each reaches. */
  servers?: PromptServer[];
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
  /** The task may write (auto). */
  writes?: boolean;
  /** `coder task run --append-system` text and flow instructions. */
  appendSystem?: string;
  /** The final message is JSON for a schema, not a summary. */
  structured?: boolean;
  /** The workspace's dashboard, where a person connects their own account. */
  dashboard?: string;
}

export type PromptServer = Pick<
  McpServerSpec,
  | 'name'
  | 'description'
  | 'connection'
  | 'url'
  | 'readOnly'
  | 'access'
  | 'integration'
  | 'owner'
  | 'account'
> & {
  /** A server connected at turn start: its instructions and tool names. */
  started?: { instructions?: string; tools: string[] };
};

/** What a server reaches: its description, else its connection or host. */
function serverSummary({ description, connection, url }: PromptServer): string {
  return (
    description ??
    (connection
      ? `connection ${connection}`
      : url && URL.canParse(url)
        ? new URL(url).host
        : 'MCP server')
  ).replace(/\s+/g, ' ');
}

const PLATFORMS_HEAD = "Platforms; each acts as this agent's app.";
const SERVERS_HEAD =
  'MCP servers; admins connect more accounts, keys or servers in the dashboard; ask when one is missing.';

/** Whose identity a server uses: a Just me connection's account, which asks its owner first; a platform's app; a workspace connection's account. */
const identity = ({ owner, account, integration, connection }: PromptServer) =>
  owner
    ? `as ${account ?? 'its owner'}; first use asks them; `
    : integration
      ? 'as the app; '
      : connection
        ? `as ${account ?? 'its account'}; `
        : '';

const serverLine = (server: PromptServer, access: Access, connected = false) =>
  `${server.name}: ${serverSummary(server)}; ${identity(server)}${connected ? 'connected, ' : ''}${server.readOnly || [server.access, access].includes('read-only') ? 'read-only' : 'read-write'}`;

/** The platforms, each connected with its servers or not, apart from the MCP servers; a personal platform's first line adds the asker's own account this turn. */
function serverLines(
  servers: PromptServer[],
  platforms: NonNullable<AgentPromptParts['platforms']>,
  access: Access,
  dashboard?: string,
) {
  const personal = (id?: string) =>
    platforms.find(platform => platform.id === id && platform.personal);
  const own = servers.filter(server => server.owner && personal(server.integration));
  const connected = servers.filter(server => server.integration && !own.includes(server));
  const others = servers.filter(server => !server.integration);
  const missing = platforms.filter(
    platform => !connected.some(server => server.integration === platform.id && !server.owner),
  );
  const stated = new Set<string>();
  const asYou = (id: string) => {
    const platform = personal(id);
    if (!platform || stated.has(id)) return '';
    stated.add(id);
    const mine = own.filter(server => server.integration === id);
    if (mine.length)
      return `; as you: connected as ${mine.map(server => `${server.account ?? 'them'} (${server.name})`).join(', ')}; first use asks them`;
    const link =
      dashboard &&
      handoffLink(
        { page: '/settings/connections', action: 'add', args: ['name', 'me'] },
        { name: id, me: true },
        dashboard,
      );

    return link
      ? `; as you: not connected; send [Connect ${platform.name}](${link}) when an ask needs it`
      : '; as you: not connected';
  };

  return [
    (connected.length || missing.length) && PLATFORMS_HEAD,
    ...connected.map(
      server => serverLine(server, access, true) + (server.owner ? '' : asYou(server.integration!)),
    ),
    ...missing.map(
      ({ id, name }) =>
        `${id}: ${name}; not connected, an admin installs it in the dashboard${asYou(id)}`,
    ),
    others.length && SERVERS_HEAD,
    ...others.map(server => serverLine(server, access)),
  ]
    .filter(Boolean)
    .join('\n');
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
      'Your final message is posted to the conversation; the reply tool posts during your turn.',
      'You may reply before longer work.',
      'Never send the same reply twice.',
      'Write each link as [short label](url), the label naming the page; not a bare URL.',
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
        'Actions outside the sandbox are reviewed and may be refused; then take another way. If the task truly needs refused actions, escalate them all in one call with the exact commands, then continue or end your turn; the decision arrives as a message, in this turn while it runs, else in a new one.',
        approved.length > 0 &&
          'Actions the user approved earlier in this task stay approved; run them outside the sandbox directly.',
      ]
        .filter(Boolean)
        .join('\n')}
    </approvals>
  ) : null;

const ACCESS: Record<Access, string> = {
  'read-only':
    'Read-only: read through your tools and reply in this conversation; no edits, posts or pushes anywhere else. Say so when asked for more; an admin can set access to auto.',
  auto: 'Auto: your tools and connections may comment, post, edit issues and push.',
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
          serverLines(
            parts.servers ?? [],
            parts.platforms ?? [],
            parts.access ?? 'auto',
            parts.dashboard,
          ),
          parts.servers?.length && TOOL_SEARCH_PROMPT,
        ]
          .filter(Boolean)
          .join('\n')}
        {parts.servers?.map(
          ({ name, started }) =>
            started && (
              <server name={name}>
                <instructions>{started.instructions}</instructions>
                <tools>{started.tools.join(', ')}</tools>
              </server>
            ),
        )}
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
