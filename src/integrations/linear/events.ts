/** Agent sessions come through the Chat SDK adapter, loaded on first use; the host verifies and parses every other webhook itself. */
import { createHmac } from 'node:crypto';

import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  EmojiValue,
  Message,
  SerializedThread,
  Thread,
} from 'chat';

import { safeEqual } from '../../utils/crypto';
import type { AdapterContext, OwnEvent, PlatformApp, PlatformEvent, WebhookTarget } from '../types';
import type { LinearAppCredentials } from './app';

const PROMPT_CONTEXT_LIMIT = 16 * 1024;

const SESSION_NOTICE = /^This thread is for an agent session with /;

/** Linear's webhook check: an HMAC of the body under the app's secret, sent within the last minute. */
export function verifyLinearWebhook(
  raw: string,
  signature: string | null,
  secret: string | undefined,
  now = Date.now(),
): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  if (!safeEqual(Buffer.from(signature, 'hex'), expected)) return false;
  const sent = (JSON.parse(raw) as { webhookTimestamp?: unknown }).webhookTimestamp;
  return typeof sent === 'number' && Math.abs(now - sent) <= 60_000;
}

type Issue = {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  teamId?: string;
  team?: { id?: string; name?: string };
  state?: { name?: string; type?: string };
  labels?: Array<{ id?: string; name?: string }>;
  priorityLabel?: string;
  assignee?: { id?: string; name?: string } | null;
  creator?: { id?: string; name?: string } | null;
};
type Comment = {
  id?: string;
  body?: string;
  parentId?: string | null;
  issue?: Issue | null;
  user?: unknown;
  botActor?: unknown;
  externalUserId?: string | null;
};
/** A Linear webhook with the fields Coder reads: data changes, Issue SLA, the app's revocation and agent sessions. */
type Webhook = {
  type?: string;
  action?: string;
  organizationId?: string;
  oauthClientId?: string;
  actor?: { id?: string; type?: string; name?: string } | null;
  data?: Issue & Comment;
  /** An update's previous values, a key for each property it changed. */
  updatedFrom?: Partial<
    Record<'title' | 'description' | 'stateId' | 'priority' | 'assigneeId', unknown>
  > & {
    labelIds?: string[];
  };
  issueData?: Issue;
  agentSession?: { issue?: { teamId?: unknown; team?: { id?: unknown } } };
};

/** The issue's team as a webhook names it, `''` when it names none. */
function webhookTeam(body: Webhook): string {
  const issue =
    body.agentSession?.issue ??
    body.issueData ??
    (body.type === 'Comment' ? body.data?.issue : body.type === 'Issue' ? body.data : undefined);
  const team = issue?.teamId ?? issue?.team?.id;

  return typeof team === 'string' ? team : '';
}

export function linearTarget(req: Request, raw: string): WebhookTarget | undefined {
  const app = new URL(req.url).searchParams.get('app');
  let body: Webhook;
  try {
    body = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const organization = body.organizationId;
  // Unknown (`''`) until `space` asks Linear; unknown counts as private.
  const team = ['AgentSessionEvent', 'Issue', 'Comment', 'IssueSLA'].includes(body.type ?? '')
    ? webhookTeam(body)
    : undefined;
  return app && typeof organization === 'string'
    ? {
        app,
        installation: organization,
        ...(team !== undefined ? { space: { kind: 'team' as const, id: team } } : {}),
      }
    : undefined;
}

/** An issue's Chat SDK thread, or a comment thread under its root, in the Linear adapter's id format. */
function linearThread(issue: string, comment?: string): SerializedThread {
  return {
    _type: 'chat:Thread',
    adapterName: 'linear',
    channelId: `linear:${issue}`,
    id: comment ? `linear:${issue}:c:${comment}` : `linear:${issue}`,
    isDM: false,
  };
}

/** Whether the event happened in an agent session, where every prompt gets an answer and replies are progress. */
export const linearSession = (event: PlatformEvent) =>
  /:s:[^:]+$/.test(event.chat?.thread.id ?? '');

const escape = (text: string) =>
  text.replace(/[&<>]/g, char => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'));

/** The issue in the shape of Linear's own `promptContext`. */
function issueContext(issue: Issue): string {
  return [
    `<issue identifier="${escape(issue.identifier ?? '')}">`,
    `<title>${escape(issue.title ?? '')}</title>`,
    issue.description && `<description>${escape(issue.description)}</description>`,
    issue.team?.name && `<team name="${escape(issue.team.name)}"/>`,
    issue.state?.name &&
      `<status type="${escape(issue.state.type ?? '')}">${escape(issue.state.name)}</status>`,
    ...(issue.labels ?? []).map(label => label.name && `<label>${escape(label.name)}</label>`),
    '</issue>',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, PROMPT_CONTEXT_LIMIT);
}

/** Whether `text` @-mentions the app by handle or profile link, which starts an agent session instead. */
function mentions(text: string, handle: string): boolean {
  const name = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  return new RegExp(`(^|[^\\w-])@${name}(?![\\w-])|/profiles/${name}(?![\\w-])`, 'i').test(text);
}

function issueEvent(
  req: Request,
  app: PlatformApp,
  body: Webhook,
  type: string,
  issue: Issue,
  text: string,
  comment?: Comment,
): PlatformEvent | undefined {
  const actor = body.actor;
  if (!body.organizationId || !issue.id || !actor?.id) return undefined;
  const team = issue.teamId ?? issue.team?.id;

  return {
    integration: 'linear',
    type,
    appId: app.id,
    installationId: body.organizationId,
    deliveryId: req.headers.get('linear-delivery') ?? '',
    actor: { id: actor.id, ...(actor.name ? { login: actor.name } : {}) },
    text,
    promptContext: issueContext(issue),
    ...(team ? { space: { kind: 'team' as const, id: team } } : {}),
    chat: { thread: linearThread(issue.id, comment && (comment.parentId ?? comment.id)) },
  };
}

/** What an issue update changed that an agent acts on, a line each; removed labels and reordering are not. */
function changes(issue: Issue, before: NonNullable<Webhook['updatedFrom']>): string[] {
  const added = (issue.labels ?? []).filter(
    label => before.labelIds && label.id && !before.labelIds.includes(label.id),
  );

  return [
    'stateId' in before && issue.state?.name && `Moved to ${issue.state.name}`,
    added.length > 0 && `Labeled ${added.map(label => label.name).join(', ')}`,
    'priority' in before && issue.priorityLabel && `Priority ${issue.priorityLabel}`,
    'assigneeId' in before &&
      (issue.assignee?.name ? `Assigned to ${issue.assignee.name}` : 'Unassigned'),
    ('title' in before || 'description' in before) && 'Edited',
  ].filter((line): line is string => Boolean(line));
}

/** An Issue or Comment webhook as its catalog event; only people's changes count, so an agent never answers itself. */
function dataEvent(req: Request, body: Webhook, app: PlatformApp): PlatformEvent | undefined {
  if (body.actor?.type !== 'user' || !body.data) return undefined;
  if (body.type === 'Issue') {
    const issue = body.data;
    const about = [issue.title, issue.description].filter(Boolean).join('\n\n');
    if (body.action === 'create') return issueEvent(req, app, body, 'issue', issue, about);
    const changed =
      body.action === 'update' && body.updatedFrom ? changes(issue, body.updatedFrom) : [];

    return changed.length
      ? issueEvent(req, app, body, 'issue', issue, `${changed.join('\n')}\n\n${about}`)
      : undefined;
  }
  const comment = body.data;
  if (
    body.type !== 'Comment' ||
    body.action !== 'create' ||
    !comment.body ||
    !comment.issue ||
    !comment.user ||
    comment.botActor ||
    comment.externalUserId ||
    mentions(comment.body, app.name)
  )
    return undefined;

  return issueEvent(req, app, body, 'comment', comment.issue, comment.body, comment);
}

/** An Issue SLA turning high risk or breached; Linear raises it, so the issue's assignee, else its creator, stands as the actor. */
function slaEvent(req: Request, body: Webhook, app: PlatformApp): PlatformEvent | undefined {
  const issue = body.issueData;
  const owner = issue?.assignee ?? issue?.creator;
  if (!issue || !owner?.id || !['highRisk', 'breached'].includes(body.action ?? ''))
    return undefined;
  const about = [issue.title, issue.description].filter(Boolean).join('\n\n');
  const state = body.action === 'breached' ? 'SLA breached' : 'SLA at high risk';

  return issueEvent(req, app, { ...body, actor: owner }, 'issue', issue, `${state}\n\n${about}`);
}

/** Every signed webhook but agent sessions, which the Chat SDK adapter verifies and handles. */
export function linearOwnEvents(
  req: Request,
  raw: string,
  app: PlatformApp,
  credentials: unknown,
): OwnEvent | undefined {
  const body = JSON.parse(raw) as Webhook;
  if (body.type === 'AgentSessionEvent') return undefined;
  const secret = (credentials as { webhookSecret?: string }).webhookSecret;
  if (!verifyLinearWebhook(raw, req.headers.get('linear-signature'), secret))
    return { invalid: true };
  if (body.type === 'OAuthApp')
    return body.action === 'revoked' &&
      body.organizationId &&
      body.oauthClientId === app.id.slice('linear:'.length)
      ? { uninstalled: `${app.id}:${body.organizationId}` }
      : { invalid: true };
  const event = body.type === 'IssueSLA' ? slaEvent(req, body, app) : dataEvent(req, body, app);

  return event ? { events: [event] } : { ack: true };
}

/** Linear marks a session unresponsive without an activity within 10 seconds, so the agent thinks aloud before dispatch. */
export function linearChatEvent(
  type: string,
  thread: Thread,
  message: Message,
): Pick<PlatformEvent, 'type' | 'actor' | 'promptContext'> & Partial<Pick<PlatformEvent, 'text'>> {
  void thread.startTyping('Reading the issue').catch(() => {});
  const context = (message.raw as { agentSessionPromptContext?: string }).agentSessionPromptContext;
  // A mention in the issue description starts the session on Linear's own notice; the issue's title is the ask.
  const title = SESSION_NOTICE.test(message.text)
    ? /<issue\b[^>]*>\s*<title>([^<]+)<\/title>/.exec(context ?? '')?.[1]?.trim()
    : undefined;
  return {
    type,
    actor: { id: message.author.userId, login: message.author.userName },
    ...(title ? { text: title } : {}),
    ...(context ? { promptContext: context.slice(0, PROMPT_CONTEXT_LIMIT) } : {}),
  };
}

/** Linear agent sessions through Chat SDK: the host verifies the webhook signature, then mints the workspace's app token. */
export async function linearAdapter(ctx: AdapterContext): Promise<Adapter> {
  const [{ LinearAdapter }, { ConsoleLogger, defaultEmojiResolver }] = await Promise.all([
    import('@chat-adapter/linear'),
    import('chat'),
  ]);

  /** Mints nothing before a webhook is verified, and posts outside one (a task's reply) for the bound workspace. */
  class BoundLinearAdapter extends LinearAdapter {
    constructor(
      config: ConstructorParameters<typeof LinearAdapter>[0],
      private readonly organization: string | undefined,
      private readonly installedSelf?: AdapterContext['installedSelf'],
      private readonly saveSelf?: AdapterContext['saveSelf'],
    ) {
      super(config);
    }

    // Chat initializes before verifying; the app identity is looked up once the webhook is verified.
    override async initialize(chat: ChatInstance): Promise<void> {
      this.chat = chat;
    }

    // The app user stored at install stands in for Linear's viewer query.
    protected override async resolveConnectIdentity(): Promise<void> {
      const self = this.organization && (await this.installedSelf?.(this.organization));
      if (!self) {
        await super.resolveConnectIdentity();
        if (this.defaultBotUserId && this.defaultOrganizationId === this.organization)
          await this.saveSelf?.(this.organization, this.defaultBotUserId);
        return;
      }
      this.defaultBotUserId = self;
      this.defaultOrganizationId = this.organization!;
    }

    private bound<T>(work: () => Promise<T>): Promise<T> {
      if (this.requestContext.getStore()) return work();
      if (!this.organization) return Promise.reject(new Error('No Linear workspace to post for'));
      return this.withInstallation(this.organization, work);
    }

    private async commentThread(issueId: string, agentSessionId: string) {
      await this.ensureValidToken();
      type Comment = { id: string; parentId?: string | null };
      type Prompts = { nodes: Array<{ createdAt: string; sourceComment?: Comment | null }> };
      const { agentSession: session } = (await this.getClient().client.request(
        `query LinearReplyTarget($id: String!) {
          agentSession(id: $id) {
            comment { id parentId }
            first: activities(first: 1, filter: { type: { eq: "prompt" } }) {
              nodes { createdAt sourceComment { id parentId } }
            }
            last: activities(last: 1, filter: { type: { eq: "prompt" } }) {
              nodes { createdAt sourceComment { id parentId } }
            }
          }
        }`,
        { id: agentSessionId },
      )) as { agentSession: { comment?: Comment | null; first: Prompts; last: Prompts } | null };
      if (!session) throw new Error('Linear returned no agent session');
      // Linear documents no sort direction, so the newer end of the prompts is the latest one.
      const prompt = [...session.first.nodes, ...session.last.nodes].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      )[0];
      // A sidebar message is a reply under the session's own comment, or no comment at all.
      const sidebar = (source?: Comment | null) =>
        !source || Boolean(session.comment && source.parentId === session.comment.id);
      if (prompt && sidebar(prompt.sourceComment)) return undefined;
      const comment = prompt ? prompt.sourceComment : session.comment;
      const parent = comment?.parentId;

      return this.encodeThreadId({ issueId, commentId: parent ?? undefined });
    }

    private async postActivity(agentSessionId: string, type: 'response' | 'error', body: string) {
      const result = await this.getClient().createAgentActivity({
        agentSessionId,
        content: { type: type as never, body },
      });
      const activity = await result.agentActivity;
      if (!result.success || !activity) throw new Error(`Linear ${type} activity failed`);

      return { id: activity.id };
    }

    override postMessage(threadId: string, message: AdapterPostableMessage) {
      return this.bound(async () => {
        const { issueId, agentSessionId } = this.decodeThreadId(threadId);
        if (!agentSessionId) return super.postMessage(threadId, message);
        const target = await this.commentThread(issueId, agentSessionId);
        if (!target) return super.postMessage(threadId, message);
        const sent = await super.postMessage(target, message);
        await this.postActivity(
          agentSessionId,
          'response',
          `[Replied in a comment](${sent.raw.comment.url})`,
        );

        return { ...sent, threadId };
      });
    }

    override addReaction(threadId: string, messageId: string, emoji: EmojiValue | string) {
      return this.bound(() =>
        super.addReaction(threadId, messageId, defaultEmojiResolver.toGChat(emoji)),
      );
    }

    override startTyping(threadId: string, status?: string) {
      return this.bound(() => super.startTyping(threadId, status));
    }

    postProgress(threadId: string, text: string) {
      const { agentSessionId } = this.decodeThreadId(threadId);
      if (!agentSessionId) return this.postMessage(threadId, { markdown: text });

      return this.bound(async () => {
        await this.ensureValidToken();
        const result = await this.getClient().createAgentActivity({
          agentSessionId,
          content: { type: 'thought' as never, body: text },
        });
        const activity = await result.agentActivity;
        if (!result.success || !activity) throw new Error('Linear progress activity failed');

        return { id: activity.id };
      });
    }

    /** A `select` elicitation whose pick comes back as a prompt holding the option's value; outside a session, a comment. */
    postElicitation(
      threadId: string,
      body: string,
      options: Array<{ label: string; value: string }>,
    ): Promise<{ id?: string }> {
      const { agentSessionId } = this.decodeThreadId(threadId);
      if (!agentSessionId) return this.postMessage(threadId, { markdown: body });

      return this.bound(async () => {
        await this.ensureValidToken();
        const result = await this.getClient().createAgentActivity({
          agentSessionId,
          content: { type: 'elicitation' as never, body },
          signal: 'select' as never,
          signalMetadata: { options },
        });
        const activity = await result.agentActivity;
        if (!result.success || !activity) throw new Error('Linear elicitation activity failed');

        return { id: activity.id };
      });
    }

    /** Failures follow the latest prompt and mark the session as failed. */
    postProblem(threadId: string, text: string) {
      return this.bound(async () => {
        const { issueId, agentSessionId } = this.decodeThreadId(threadId);
        if (!agentSessionId) return super.postMessage(threadId, { markdown: text });
        const target = await this.commentThread(issueId, agentSessionId);
        const sent = target ? await super.postMessage(target, { markdown: text }) : undefined;
        const activity = await this.postActivity(
          agentSessionId,
          'error',
          sent ? `[Failed in a comment](${sent.raw.comment.url})` : text,
        );

        return sent ?? activity;
      });
    }
  }

  const secret = (ctx.credentials as LinearAppCredentials | undefined)?.webhookSecret;
  const organization = ctx.installationId;
  return new BoundLinearAdapter(
    {
      mode: 'agent-sessions',
      userName: ctx.name,
      // Set, so no LINEAR_* variable redirects the token or replaces the key.
      apiUrl: 'https://api.linear.app/graphql',
      encryptionKey: '',
      accessToken: () =>
        organization
          ? ctx.token(organization)
          : Promise.reject(new Error('The webhook names no Linear workspace')),
      // Without the app's secret (a task's runner, which only posts) no webhook is ever accepted.
      webhookVerifier: (req, body) =>
        verifyLinearWebhook(body, req.headers.get('linear-signature'), secret),
      logger: new ConsoleLogger('error'),
    },
    organization,
    ctx.installedSelf,
    ctx.saveSelf,
  );
}
