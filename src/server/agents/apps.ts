import process from 'node:process';

import { builtinDefinitions, defaultAgent } from '../../agent/load';
import { enabledIntegrations } from '../../integrations';
import type { CreateState } from '../../integrations/types';
import type { AgentApp, AgentDefinition } from '../../agent/types';
import { CoderError } from '../../core/dispatch';
import { encodeJson } from '../../utils/base64url';
import { issueNonce } from '../auth/nonce';
import { scoped, type ServerContext } from '../context';
import { loadServerConfig } from '../env';
import { createTarget, dashOrigin, OPERATOR } from './platform';
import { createBackend } from '../store';

export interface ServerAppOptions {
  /** Where the app lives, such as a GitHub organization; the operator's own account when absent. */
  owner?: string;
  name?: string;
  env?: Record<string, string | undefined>;
}

/** This server's shared apps, made by `coder server app create`. */
export async function sharedApps(
  ctx: Pick<
    ServerContext,
    'store' | 'integrations' | 'organizationId' | 'serverOrganizationId' | 'scope'
  >,
): Promise<AgentApp[]> {
  const store =
    ctx.serverOrganizationId && ctx.serverOrganizationId !== ctx.organizationId
      ? (ctx.scope?.(ctx.serverOrganizationId).store ?? ctx.store)
      : ctx.store;

  return (await store.list('app'))
    .map(({ value }) => value)
    .filter(app => app.builtin && ctx.integrations[app.integration]?.app.builtin === 'shared');
}

/** The one-time page that creates the built-in agent's public app on `integration`, stored for the whole server. */
export async function serverAppLink(
  integration: string,
  options: ServerAppOptions = {},
): Promise<{ url: string }> {
  const config = loadServerConfig(options.env ?? process.env);
  const integrations = enabledIntegrations(config.integrations);
  if (!integrations[integration])
    throw new CoderError('invalid-option', `Unknown integration "${integration}".`, {
      hint: `Pick one of ${Object.keys(integrations).join(', ')}.`,
    });
  if (integrations[integration]!.app.builtin !== 'shared')
    throw new CoderError(
      'invalid-option',
      `Create ${integration} apps in your workspace from the agent's Platforms tab.`,
    );
  if (!config.databaseUrl || !config.publicUrl)
    throw new CoderError('invalid-option', 'Built-in apps need the server database and address.', {
      hint: 'Set DATABASE_URL and PUBLIC_URL as the server has them.',
    });
  const backend = await createBackend(config);
  try {
    const organizationId = backend.defaultOrganizationId;
    const ctx = {
      config,
      integrations,
      organizationId,
      store: backend.store(organizationId),
    } as ServerContext;
    return { url: await serverAppUrl(ctx, integration, options) };
  } finally {
    await backend.close();
  }
}

/** The create page for `integration`'s built-in app, with a transaction issued in `ctx`, the server's organization. */
export async function serverAppUrl(
  ctx: ServerContext,
  integration: string,
  options: Pick<ServerAppOptions, 'owner' | 'name'>,
): Promise<string> {
  if (ctx.integrations[integration]?.app.builtin !== 'shared')
    throw new CoderError(
      'invalid-option',
      `Create ${integration} apps in your workspace from the agent's Platforms tab.`,
    );
  const agent = defaultAgent();
  if (!agent) throw new CoderError('invalid-option', 'This server ships no default agent.');
  const shipped = builtinDefinitions()[agent]!.json as AgentDefinition;
  const definition = { ...shipped, ...(options.name ? { name: options.name } : {}) };
  const state: CreateState = {
    agent,
    def: encodeJson(definition),
    ...(options.owner ? { owner: options.owner } : {}),
    public: true,
  };
  const tx = await issueNonce(ctx, 'create', OPERATOR, createTarget(integration, state));
  const query = new URLSearchParams({
    agent: state.agent,
    def: state.def,
    ...(state.owner ? { owner: state.owner } : {}),
    public: '1',
    tx,
  });
  // A local server's pages only load on its own origin; the tunnel serves platform paths.
  const base = dashOrigin(ctx) || ctx.config.publicUrl!.replace(/\/$/, '');

  return `${base}/create/${integration}?${query}`;
}
