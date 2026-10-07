import process from 'node:process';

import { BUILTIN_AGENT, builtinDefinitions } from '../../agent/load';
import { enabledIntegrations } from '../../integrations';
import type { CreateState } from '../../integrations/types';
import type { AgentDefinition } from '../../agent/types';
import { CoderError } from '../../core/dispatch';
import { encodeJson } from '../../utils/base64url';
import { issueNonce } from '../auth/nonce';
import type { ServerContext } from '../context';
import { loadServerConfig } from '../env';
import { createTarget, OPERATOR } from './platform';
import { createBackend } from '../store';

export interface ServerAppOptions {
  /** Where the app lives, such as a GitHub organization; the operator's own account when absent. */
  owner?: string;
  name?: string;
  env?: Record<string, string | undefined>;
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
  if (!config.databaseUrl || !config.publicUrl)
    throw new CoderError('invalid-option', 'Built-in apps need the server database and address.', {
      hint: 'Set DATABASE_URL and PUBLIC_URL as the server has them.',
    });
  const shipped = builtinDefinitions()[BUILTIN_AGENT]!.json as AgentDefinition;
  const definition = { ...shipped, ...(options.name ? { name: options.name } : {}) };
  const state: CreateState = {
    agent: BUILTIN_AGENT,
    def: encodeJson(definition),
    ...(options.owner ? { owner: options.owner } : {}),
    public: true,
  };
  const backend = await createBackend(config);
  try {
    const organizationId = backend.defaultOrganizationId;
    const ctx = { config, organizationId, store: backend.store(organizationId) } as ServerContext;
    const tx = await issueNonce(ctx, 'create', OPERATOR, createTarget(integration, state));
    const query = new URLSearchParams({
      agent: state.agent,
      def: state.def,
      ...(state.owner ? { owner: state.owner } : {}),
      public: '1',
      tx,
    });
    return { url: `${config.publicUrl.replace(/\/$/, '')}/create/${integration}?${query}` };
  } finally {
    await backend.close();
  }
}
