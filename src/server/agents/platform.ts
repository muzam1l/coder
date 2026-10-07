import { type CreateState } from '../../integrations/types';
import {
  type AgentApp,
  type AgentDefinition,
  type Connection,
  type Installation,
} from '../../agent/types';
import { issueNonce } from '../auth/nonce';
import { encodeJson } from '../../utils/base64url';
import { escapeHtml, htmlResponse } from '../../utils/html';
import { type ServerContext } from '../context';
import { decodeParam } from '../routes/http';

export const OPERATOR = '*';

export type AppsContext = ServerContext & { fetch?: typeof fetch; operatorApp?: boolean };

export const page = (body: string, status = 200) =>
  htmlResponse(
    `<title>Coder</title><p>${escapeHtml(body)}</p>` +
      (status >= 400 ? '<p><a href="/dash">Back to the dashboard</a> to start again.</p>' : ''),
    status,
  );

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
  const connection: Connection = { kind: 'installation', id };
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
