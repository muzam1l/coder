import { type AgentDefinition } from '../../agent/types';
import type { AppSpec } from '../../integrations/types';
import { consumeNonce, inspectNonce } from '../auth/nonce';
import { type SetupOutcome } from '../../client/types';
import { type ServerContext } from '../context';
import { decodeParam, redirect } from '../routes/http';
import { dashPath, sessionSlug } from '../auth/account';

export const OPERATOR = '*';

export type AppsContext = ServerContext & { fetch?: typeof fetch; operatorApp?: boolean };

/** The app a definition asks for on `integration`, named for the agent unless the definition names itself. */
export function appSpec(definition: AgentDefinition, agent: string, integration: string): AppSpec {
  const events = definition.integrations[integration]?.events;

  return {
    name: definition.name ?? agent,
    ...(definition.description ? { description: definition.description } : {}),
    events: Array.isArray(events) ? events : Object.keys(events ?? {}),
    ...(definition.access ? { access: definition.access } : {}),
    commands: [
      {
        command: '/setup',
        description: 'Configure this agent',
        usage: 'repo owner/name | model <name> | show',
      },
    ],
  };
}

/** What the dashboard's app creation puts in the URL; only `tx` goes to the platform and back. */
export interface CreateState {
  agent: string;
  repo?: string;
  branch?: string;
  /** base64url `agent.json`. */
  def: string;
  /** Signed, stored browser transaction returned by the platform callback. */
  tx?: string;
  /** Where the app lives, such as a GitHub organization; the creator's own account when absent. */
  owner?: string;
  /** Any account may install the app, not only the one that owns it. */
  public?: boolean;
}

/** Ends a create, install or link flow in the dashboard: `back` when the flow knows it, else the setup page. */
export function outcome(
  ctx: ServerContext,
  status: SetupOutcome['status'],
  params: Omit<SetupOutcome, 'status'> & { tx?: string } = {},
  back?: string,
): Response {
  const query = new URLSearchParams({ status });
  for (const [key, value] of Object.entries(params))
    if (value?.length) query.set(key, Array.isArray(value) ? value.join(',') : value);
  // Only a platform's short error code travels, never its free text.
  if (!/^[\w.-]{1,64}$/.test(query.get('error') ?? '')) query.delete('error');

  const page = back ?? dashPath(sessionSlug(ctx), '/setup');

  return redirect(`${dashOrigin(ctx)}${page.replace(/[?#].*$/, '')}?${query}`);
}

/** Where this server's dashboard is open: a local server's tunnel serves only platform paths. */
export const dashOrigin = (ctx: ServerContext) =>
  ctx.local ? `http://localhost:${ctx.local.port}` : '';

/** An agent's Platforms tab. */
export const platformsPath = (ctx: ServerContext, agent: string) =>
  dashPath(sessionSlug(ctx), `/agents/${encodeURIComponent(agent)}/platforms`);

export function readState(
  source: URLSearchParams,
): { state: CreateState; definition: AgentDefinition } | undefined {
  const agent = source.get('agent');
  const def = source.get('def');
  const definition = decodeParam<AgentDefinition>(def);
  if (!agent || !def || !definition?.integrations) return undefined;
  return {
    state: {
      agent,
      repo: source.get('repo') ?? undefined,
      branch: source.get('branch') ?? undefined,
      def,
      tx: source.get('tx') ?? undefined,
      owner: source.get('owner') || undefined,
      ...(['1', 'true'].includes(source.get('public') ?? '') ? { public: true } : {}),
    },
    definition,
  };
}

export const backPath = (value: unknown) =>
  typeof value === 'string' && /^\/dash(?:[/?#]|$)/.test(value) ? value : undefined;

export const createTarget = (integration: string, state: CreateState) =>
  JSON.stringify({
    integration,
    agent: state.agent,
    repo: state.repo ?? null,
    branch: state.branch ?? null,
    def: state.def,
    owner: state.owner ?? null,
    public: state.public ?? false,
  });

/** Consume a `create` transaction for this user and integration, and rebuild the state it is bound to. */
export async function takeCreateState(
  ctx: ServerContext,
  tx: string,
  integration: string,
  user: string,
): Promise<{ state: CreateState; definition: AgentDefinition } | undefined> {
  const target = await inspectNonce(ctx, tx, 'create', user);
  const saved = target
    ? (JSON.parse(target) as Record<'integration' | 'agent' | 'def', string> &
        Record<'repo' | 'branch' | 'owner', string | null> & { public: boolean })
    : undefined;
  const definition = decodeParam<AgentDefinition>(saved?.def ?? null);
  if (
    saved?.integration !== integration ||
    !definition?.integrations ||
    !(await consumeNonce(ctx, tx, 'create', user, target!))
  )
    return undefined;

  return {
    state: {
      agent: saved.agent,
      repo: saved.repo ?? undefined,
      branch: saved.branch ?? undefined,
      def: saved.def,
      tx,
      owner: saved.owner ?? undefined,
      ...(saved.public ? { public: true } : {}),
    },
    definition,
  };
}
