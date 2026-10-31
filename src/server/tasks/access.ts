/** Who a request is and what it sees: a task's attempt token and principal, and the audience a task shows to (admins every one, the member who asked their own, members those of public spaces and of the private spaces whose stored member lists hold them). */
import { randomBytes } from 'node:crypto';

import type { Access } from '../../core/config';
import type { AgentEvent, AgentTask, AgentUsage, RunnerTrust } from '../../agent/types';
import { taskTrust } from './grants';
import type { Integration, MembersChange, SpaceChange, TokenBound } from '../../integrations/types';
import { scoped, type ServerContext, type SessionInfo } from '../context';
import { installationToken } from './context';
import { workspaceAdmin } from '../routes/guards';
import { json } from '../routes/http';
import type { Params } from '../routes/match';
import { decryptSecret, encryptSecret } from '../store/secrets';
import { taskRunner } from '../runners/select';
import { decodeJson, encodeJson, sha256 } from '../../utils/crypto';

/** A task attempt's bearer token: base64url claims, a dot, then random bytes; only its hash is stored. */
interface TaskClaims {
  task?: string;
  organization?: string;
  attempt?: number;
}

export const taskTokenHash = sha256;

export function createTaskToken(
  task: string,
  organization: string,
  attempt: number,
  nonce = randomBytes(32).toString('base64url'),
): { token: string; hash: string } {
  const token = `${encodeJson({ task, organization, attempt })}.${nonce}`;
  return { token, hash: taskTokenHash(token) };
}

export function taskClaims(token: string): TaskClaims {
  try {
    const claims = decodeJson<TaskClaims | null>(token.slice(0, token.indexOf('.')));

    return claims && typeof claims === 'object' ? claims : {};
  } catch {
    return {};
  }
}

/** How long a start's claim code waits for its machine to trade it. */
const CLAIM_TTL_MS = 10 * 60_000;
const claimKey = (claim: string) => `task-claim:${sha256(claim)}`;

/** A code shaped like a task token, with no attempt, that its machine trades once for `token`, so the token never travels where others read it. */
export async function createClaim(ctx: ServerContext, token: string): Promise<string> {
  const { task, organization } = taskClaims(token);
  const claim = `${encodeJson({ task, organization })}.${randomBytes(32).toString('base64url')}`;
  const expiresAt = (ctx.now ?? Date.now)() + CLAIM_TTL_MS;
  await ctx.store.put(
    'snapshot',
    claimKey(claim),
    { secret: encryptSecret(ctx.config, token), expiresAt },
    { ttlMs: CLAIM_TTL_MS },
  );

  return claim;
}

/** `POST /tasks/:id/claim`: the attempt token a claim code of that task holds, the first time only, for the machine its runner started. */
export async function redeemClaim(req: Request, base: ServerContext, params: Params) {
  const { claim, identity } = ((await req.json().catch(() => undefined)) ?? {}) as {
    claim?: unknown;
    identity?: unknown;
  };
  const { task, organization } = typeof claim === 'string' ? taskClaims(claim) : {};
  if (
    typeof claim !== 'string' ||
    typeof identity !== 'string' ||
    typeof task !== 'string' ||
    task !== params.id ||
    typeof organization !== 'string'
  )
    return new Response('Unauthorized', { status: 401 });
  const ctx = scoped(base, organization);
  const status = await ctx.store.get('task', task);
  if (!status) return new Response('Unauthorized', { status: 401 });
  // The handle lands once the dispatch returns, so the machine asks again.
  if (!status.handle) return new Response('Not started yet', { status: 409 });
  const runner = await taskRunner(ctx, status.task);
  const audience = (ctx.config.publicUrl ?? '').replace(/\/+$/, '');
  if (!(await runner?.verifyJob?.(status.handle, identity, audience)))
    return new Response('Unauthorized', { status: 401 });
  const held = await ctx.store.take('snapshot', claimKey(claim));
  if (!held || !('secret' in held) || (held.expiresAt ?? 0) <= (ctx.now ?? Date.now)())
    return new Response('Unauthorized', { status: 401 });

  return json({ token: decryptSecret<string>(ctx.config, held.secret) });
}

/** Whether a bearer is shaped like a task attempt token, whatever its validity. */
export function isTaskToken(token: string): boolean {
  const claims = taskClaims(token);
  return (
    typeof claims === 'object' &&
    claims !== null &&
    typeof claims.task === 'string' &&
    typeof claims.organization === 'string' &&
    Number.isInteger(claims.attempt)
  );
}

/** The task a request acts as, from its attempt token: it reaches only its children and its own agent. */
export interface TaskPrincipal {
  task: string;
  agent: string;
  attempt: number;
  /** The linked member who asked, in a 1:1 DM only; a shared thread acts as the workspace. */
  requestedBy?: string;
  /** The linked member whose message started this turn, in any conversation. */
  asker?: string;
  user?: { name: string; email: string };
  dm: boolean;
  access: Access;
  /** The connections it is granted, which bound its children's. */
  connections: string[];
  /** What its children show to. */
  audience: string;
  /** Who operates its runner; shared state changes from anything but workspace trust wait for a person. */
  trust: RunnerTrust;
  space?: string;
}

/** The principal of the task behind `token`, while that attempt runs in `ctx`'s organization. */
export async function taskPrincipal(
  ctx: ServerContext,
  token: string,
): Promise<TaskPrincipal | undefined> {
  const claims = taskClaims(token);
  if (!isTaskToken(token) || claims.organization !== ctx.organizationId) return undefined;
  const state = await ctx.queue.authorize(
    claims.task!,
    taskTokenHash(token),
    claims.attempt!,
    ctx.organizationId,
    (ctx.now ?? Date.now)(),
  );
  if (!state) return undefined;
  const { task } = state.status;
  const { audience, space } = taskAudience(task);

  return {
    task: task.id,
    agent: task.agent,
    attempt: claims.attempt!,
    ...(task.requestedBy && !sharedConversation(task) ? { requestedBy: task.requestedBy } : {}),
    ...(task.context?.asker ? { asker: task.context.asker } : {}),
    ...(task.context?.user ? { user: task.context.user } : {}),
    dm: task.event?.chat?.thread.isDM === true,
    access: task.access ?? 'auto',
    connections: task.connections ?? [],
    audience,
    trust: taskTrust(task),
    ...(space ? { space } : {}),
  };
}

/** The context a task's request runs in: the member who asked as the session in a DM; lists and reads take `parent` from the principal. */
export function principalContext(ctx: ServerContext, principal: TaskPrincipal): ServerContext {
  const session: SessionInfo | undefined = principal.requestedBy
    ? {
        user: {
          id: principal.requestedBy,
          name: principal.user?.name ?? '',
          email: principal.user?.email ?? '',
        },
        organizationId: ctx.organizationId,
        role: 'member',
        organizations: [],
      }
    : undefined;

  return { ...ctx, taskPrincipal: principal, ...(session ? { session } : {}) };
}

const DIRECT_SETTINGS = new Set(['engine', 'model', 'effort']);

/** Why a task may not write `next` over its agent's `current` settings: anything beyond engine, model and effort must stay as it is. */
export function settingsProblem(
  current: AgentUsage | undefined,
  next: unknown,
): string | undefined {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return 'settings must be an object';
  const keys = new Set([...Object.keys(current ?? {}), ...Object.keys(next)]);
  for (const key of keys) {
    if (DIRECT_SETTINGS.has(key)) continue;
    const before = JSON.stringify((current as Record<string, unknown> | undefined)?.[key]);
    const after = JSON.stringify((next as Record<string, unknown>)[key]);
    if (before !== after)
      return `A task changes only its agent's engine, model and effort, not ${key}.`;
  }

  return undefined;
}

/** A member who is not an admin: their id, and which of the asked private space audiences their stored member lists grant. */
export interface Viewer {
  id: string;
  /** Absent where the queue reads the stored member lists in its own query. */
  spaces?: string[];
}

/** What a space is known by, as a task event carries it. */
export type SpaceEvent = Pick<
  AgentEvent,
  'integration' | 'appId' | 'installationId' | 'account' | 'space'
>;

/** A member list this old is fetched again on its space's next event; until then it stands. */
export const MEMBERS_TTL_MS = 24 * 60 * 60_000;

/** A fetch claim expires this long after it was taken, so a crashed server holds no space forever. */
export const MEMBERS_CLAIM_MS = 60_000;

/** A space's key: the integration, the platform account it lives in and the space's own id. */
export const spaceKey = (event: SpaceEvent) =>
  `${event.integration}:${event.account ?? event.installationId}:${event.space?.id ?? ''}`;

/** The audience of a private space's tasks. */
export const spaceAudience = (event: SpaceEvent) => `space:${spaceKey(event)}`;

/** Who a task shows to, decided once when it is created: a child keeps what it copied from its parent; a DM shows to the member who asked; a platform event shows to its space's members unless the space is known public; a task started from the dashboard, the CLI or a schedule, on a repo or not, shows to every member. */
export function taskAudience(
  task: Pick<AgentTask, 'source' | 'event' | 'requestedBy' | 'audience' | 'space'>,
): Pick<AgentTask, 'space'> & { audience: string } {
  if (task.audience !== undefined)
    return { audience: task.audience, ...(task.space ? { space: task.space } : {}) };
  const event = task.event;
  if (!event?.integration || task.source !== event.integration) return { audience: '' };
  const space = spaceKey(event);
  if (event.chat?.thread.isDM) return { audience: `dm:${task.requestedBy ?? ''}`, space };

  return { audience: event.space?.private === false ? '' : spaceAudience(event), space };
}

/** A platform task outside a 1:1 DM, where anyone may write: it acts as the workspace, whoever started it. */
export const sharedConversation = (task: Pick<AgentTask, 'source' | 'event'>) =>
  Boolean(task.event && task.source === task.event.integration && !task.event.chat?.thread.isDM);

/** The member whose credentials and runner a turn uses: its starter, when the turn is theirs; none runs on the workspace's. */
export function turnStarter(
  task: Pick<AgentTask, 'source' | 'event' | 'requestedBy' | 'context'>,
): string | undefined {
  const asker = task.context?.asker ?? (sharedConversation(task) ? undefined : task.requestedBy);

  return asker && asker === task.requestedBy ? asker : undefined;
}

/** Whether a viewer sees a task or hears its delete: no viewer is an admin or a task, which see every one; a member sees public tasks, their own, and those of the private spaces they are listed in. An unknown audience shows only to the member who asked. */
export const canView = (
  viewer: Viewer | undefined,
  task: Pick<AgentTask, 'audience' | 'requestedBy'>,
): boolean =>
  viewer === undefined ||
  task.audience === '' ||
  task.requestedBy === viewer.id ||
  task.audience === `dm:${viewer.id}` ||
  Boolean(task.audience && viewer.spaces?.includes(task.audience));

/** How the caller sees tasks: none for an admin or a task; for a member, which of the private space `audiences` their stored member lists grant, else left to the queue's own query. */
export async function viewer(
  ctx: ServerContext,
  audiences?: Array<string | undefined>,
): Promise<Viewer | undefined> {
  if (workspaceAdmin(ctx) || ctx.taskPrincipal) return undefined;
  const id = ctx.session?.user.id ?? '';
  if (!id) return { id, spaces: [] };
  if (!audiences) return { id };
  const wanted = [
    ...new Set(audiences.filter((key): key is string => Boolean(key?.startsWith('space:')))),
  ];

  return {
    id,
    spaces: wanted.length ? await ctx.queue.memberSpaces(ctx.organizationId, id, wanted) : [],
  };
}

/** The event's space with its privacy: as it arrived, else asked of its platform for each new task; an error leaves it unknown. */
export async function eventSpace(
  ctx: ServerContext,
  integration: Integration,
  event: AgentEvent,
  token: () => Promise<string | undefined>,
): Promise<AgentEvent['space']> {
  const ask = integration.auth.space;
  if (event.space?.private !== undefined || !ask || !(event.space?.id || event.chat?.thread.id))
    return event.space;

  try {
    return (await ask(event, (await token())!, ctx.fetch ?? fetch)) ?? event.space;
  } catch (error) {
    console.error(`coder server: space of ${spaceKey(event)} unknown`, error);

    return event.space;
  }
}

/** Fetches a private space's member list during its event's own work, when missing or older than `MEMBERS_TTL_MS` or when `force`d; one fetch at a time across servers, a `force`d one taking over and voiding the fetch in flight, and a failure writes no list. */
export async function syncMembers(
  ctx: ServerContext,
  integration: Integration,
  event: SpaceEvent & Partial<Pick<AgentEvent, 'chat'>>,
  token: () => Promise<string | undefined>,
  force = false,
): Promise<void> {
  const members = integration.auth.members;
  if (!members || !event.space?.id) return;
  const sample = { source: event.integration, event: event as AgentEvent };
  if (!taskAudience(sample).audience.startsWith('space:')) return;
  const now = (ctx.now ?? Date.now)();

  try {
    const synced = await ctx.queue.spaceSynced(ctx.organizationId, event);
    if (!force && synced !== undefined && now - synced < MEMBERS_TTL_MS) return;
    if (!(await ctx.queue.claimSpace(ctx.organizationId, event, now, force))) return;
    let listed: string[] | undefined;
    try {
      listed = await members(event.space, (await token())!, ctx.fetch ?? fetch, () =>
        ctx.queue.linkedMembers(ctx.organizationId, integration.id),
      );
    } finally {
      await ctx.queue.saveSpaceMembers(ctx.organizationId, event, listed, now);
    }
  } catch (error) {
    console.error(`coder server: members of ${spaceKey(event)} not fetched`, error);
  }
}

/** Applies a platform's report that a space's members or privacy changed; a space turned private has its members fetched at once. */
export async function spaceChanged(
  ctx: ServerContext,
  integration: Integration,
  appId: string,
  credentials: unknown,
  change: SpaceChange,
): Promise<void> {
  const event: SpaceEvent = {
    integration: integration.id,
    appId,
    installationId: change.installation,
    ...(change.account ? { account: change.account } : {}),
    space: change.space,
  };
  await ctx.queue.spaceChanged(
    ctx.organizationId,
    event,
    {
      ...(change.joined ? { joined: change.joined } : {}),
      ...(change.left ? { left: change.left } : {}),
      ...(change.space.private !== undefined ? { private: change.space.private } : {}),
    },
    (ctx.now ?? Date.now)(),
  );
  if (change.space.private !== true) return;

  await syncMembers(ctx, integration, event, () =>
    spaceToken(ctx, integration, event, credentials),
  );
}

/** Fetches again the stored member lists a platform's report of team or account membership reaches. */
export async function membersChanged(
  ctx: ServerContext,
  integration: Integration,
  appId: string,
  credentials: unknown,
  change: MembersChange,
): Promise<void> {
  const account: SpaceEvent = {
    integration: integration.id,
    appId,
    installationId: change.installation,
    ...(change.account ? { account: change.account } : {}),
  };
  const teamSpaces = integration.auth.teamSpaces;
  if (change.team && !teamSpaces) return;
  const token = () => spaceToken(ctx, integration, account, credentials);

  try {
    const listed = await ctx.queue.listedSpaces(ctx.organizationId, account);
    if (!listed.length) return;
    // The installation's full token, as reading a team needs the members permission no tool preset has.
    const spaces = change.team
      ? await teamSpaces!(
          change.team,
          await spaceToken(ctx, integration, account, credentials, {}),
          ctx.fetch ?? fetch,
        )
      : change.spaces;
    for (const event of listed)
      if (!spaces || spaces.includes(event.space?.id ?? ''))
        await syncMembers(ctx, integration, event, token, true);
  } catch (error) {
    console.error(`coder server: members of ${spaceKey(account)} not fetched again`, error);
  }
}

/** A read token of the installation a space lives in. */
async function spaceToken(
  ctx: ServerContext,
  integration: Integration,
  event: SpaceEvent,
  credentials: unknown,
  bound: TokenBound = { tools: integration.tools.presets['read-only'] },
): Promise<string> {
  const installation = await ctx.store.get(
    'installation',
    `${event.appId}:${event.installationId}`,
  );
  if (!installation || installation.deletedAt) throw new Error('No installation');

  return installationToken(ctx, integration, installation, credentials, bound);
}
