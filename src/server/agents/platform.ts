import { type CreateState } from '../../integrations/types';
import {
  type AgentApp,
  type AgentDefinition,
  type InstallationLink,
  type Installation,
} from '../../agent/types';
import { consumeNonce, inspectNonce, issueNonce } from '../auth/nonce';
import { type SetupOutcome } from '../../client/types';
import { encodeJson } from '../../utils/base64url';
import { type ServerContext } from '../context';
import { decodeParam, redirect } from '../routes/http';

export const OPERATOR = '*';

export type AppsContext = ServerContext & { fetch?: typeof fetch; operatorApp?: boolean };

/** Ends a create, install or link flow in the dashboard: `back` when the flow knows it, else `/dash/setup`. */
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

  return redirect(`${dashOrigin(ctx)}${(back ?? '/dash/setup').replace(/[?#].*$/, '')}?${query}`);
}

/** Where this server's dashboard is open: a local server's tunnel serves only platform paths. */
export const dashOrigin = (ctx: ServerContext) =>
  ctx.local ? `http://localhost:${ctx.local.port}` : '';

/** An agent's Platforms tab. */
export const platformsPath = (agent: string) =>
  `/dash/agents/${encodeURIComponent(agent)}/platforms`;

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

export async function siblingApp(
  ctx: ServerContext,
  app: AgentApp,
  integration: string,
): Promise<AgentApp | undefined> {
  const apps = await ctx.store.list('app', {
    prefix: `${integration}:`,
  });

  return apps.find(
    entry => entry.value.integration === integration && entry.value.agent === app.agent,
  )?.value;
}

export function link(installation: Installation, integration: string, id: string): Installation {
  const connection: InstallationLink = { kind: 'installation', id };
  return {
    ...installation,
    connections: { ...installation.connections, [integration]: connection },
  };
}

export function connectLinks(ctx: AppsContext, app: AgentApp, publicUrl: string) {
  return async (installationId: string): Promise<Record<string, string>> => {
    const links: Record<string, string> = {};
    for (const id of Object.keys(ctx.integrations)) {
      if (id === app.integration) continue;
      const sibling = await siblingApp(ctx, app, id);
      if (sibling) {
        const tx = await issueNonce(
          ctx,
          'install',
          ctx.session?.user.id ?? 'anonymous',
          sibling.id,
        );
        links[id] =
          `${publicUrl}/install/${id}?app=${encodeURIComponent(sibling.id)}&state=${encodeJson({ link: installationId, tx })}`;
      }
    }
    return links;
  };
}

export async function linkedSibling(
  ctx: ServerContext,
  linked: Installation,
  integration: string,
): Promise<AgentApp | undefined> {
  const app = await ctx.store.get('app', linked.app);

  return app && siblingApp(ctx, app, integration);
}
