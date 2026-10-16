import { appTokens } from './tokens';
import { type Params } from '../routes/match';
import { decryptSecret, encryptSecret } from '../store/secrets';
import { InstallationBoundError, type Store } from '../store/types';
import { checkBinding } from '../store/memory';
import { type AgentApp, type Installation } from '../../agent/types';
import { type Integration, IntegrationError } from '../../integrations/types';
import { consumeNonce, inspectNonce, issueNonce, nonceOrganization } from '../auth/nonce';
import { memberOf } from '../auth/connect';
import { encodeJson } from '../../utils/base64url';
import { agentWithVersion } from './records';
import { credentialFix, resolveEngine } from '../settings/credentials';
import { decodeParam, redirect } from '../routes/http';
import {
  type AppsContext,
  OPERATOR,
  outcome,
  platformsPath,
  link,
  linkedSibling,
  backPath,
} from './platform';

/** Write an installation under its lock from its current value; the same app's own installations of accounts it now covers are retired. */
export function storeInstallation(
  store: Store,
  id: string,
  next: (current: Installation | undefined) => Installation | undefined,
  now: number,
): Promise<Installation | undefined> {
  return store.withAppLock(`installation:${id}`, async locked => {
    const value = next(await locked.get('installation', id));
    if (!value) return undefined;

    const rows = await locked.list('installation');
    const retiring = rows.filter(
      row =>
        row.id !== id &&
        row.value.app === value.app &&
        !row.value.deletedAt &&
        value.covers?.includes(row.id.slice(value.app.length + 1)),
    );
    const retired = new Set(retiring.map(row => row.id));
    checkBinding(
      rows.map(row => [row.id, retired.has(row.id) ? { ...row.value, deletedAt: now } : row.value]),
      id,
      value,
    );
    for (const own of retiring)
      await locked.put('installation', own.id, { ...own.value, deletedAt: now });
    await locked.put('installation', id, value);

    return value;
  });
}

export async function installPage(
  req: Request,
  ctx: AppsContext,
  params: Params,
  url: URL,
): Promise<Response | undefined> {
  const id = params.id!;
  const operator = ctx.operatorApp ?? false;
  const userId = operator ? OPERATOR : (ctx.session?.user.id ?? 'anonymous');
  const linkState = decodeParam<{
    link?: string;
    tx?: string;
    back?: string;
  }>(url.searchParams.get('state'));
  const back = backPath(linkState?.back);
  const integration = ctx.integrations[id!];
  if (!integration) return outcome(ctx, 'unknown-integration', { platform: id }, back);

  const publicUrl = ctx.config.publicUrl;
  if (!publicUrl) return outcome(ctx, 'no-public-url', {}, back);

  const appId = url.searchParams.get('app');
  const transactionTarget = linkState?.tx
    ? await inspectNonce(ctx, linkState.tx, 'install', userId)
    : undefined;
  if (!transactionTarget || (appId && appId !== transactionTarget))
    return outcome(ctx, 'install-expired', { platform: id, appId: appId ?? undefined }, back);

  const app = await ctx.store.get('app', appId ?? transactionTarget);
  if (!app) return outcome(ctx, 'unknown-app', { platform: id }, back);

  const credentials = decryptSecret(ctx.config, app!.credentials);

  return redirect(
    integration.app.installUrl(app!, credentials, {
      publicUrl,
      state: url.searchParams.get('state') ?? encodeJson({}),
    }),
  );
}

/** A platform-started install: re-authorizes in the app's workspace; the callback's own code is never used. */
async function platformInstall(
  req: Request,
  ctx: AppsContext,
  integration: Integration,
  request: typeof fetch,
): Promise<Response> {
  const id = integration.id;
  const rows = ctx.apps
    ? await ctx.apps(id)
    : (await ctx.store.list('app', { prefix: `${id}:` })).map(entry => ({
        organizationId: ctx.organizationId,
        app: entry.value,
      }));
  const found = await integration.app.installedApp!(req, {
    apps: rows.map(({ app }) => ({ app, credentials: decryptSecret(ctx.config, app.credentials) })),
    fetch: request,
  }).catch((error: unknown) => {
    console.error(`coder server: finding the ${id} app of an install failed`, error);

    return error instanceof Error ? error : new Error(String(error));
  });
  if (found instanceof Error) return outcome(ctx, 'failed', { platform: id });
  if (!found) return outcome(ctx, 'unknown-app', { platform: id });

  const { app, installation } = found;
  // The shared app binds where a dashboard install would: the session's workspace.
  const owner = rows.find(row => row.app.id === app.id)!.organizationId;
  const member = app.builtin || !ctx.session ? ctx : memberOf(ctx, ctx.session, owner);
  if (!member) return outcome(ctx, 'other-workspace', { platform: id });

  const tx = await issueNonce(member, 'install', ctx.session?.user.id ?? 'anonymous', app.id);

  return redirect(
    integration.app.installUrl(app, decryptSecret(ctx.config, app.credentials), {
      publicUrl: ctx.config.publicUrl!,
      state: encodeJson({ tx, installation }),
      installation,
    }),
  );
}

export async function completeInstall(
  req: Request,
  entry: AppsContext,
  params: Params,
  url: URL,
): Promise<Response | undefined> {
  const id = params.id!;
  const operator = entry.operatorApp ?? false;
  const userId = operator ? OPERATOR : (entry.session?.user.id ?? 'anonymous');
  const linkState = decodeParam<{
    link?: string;
    tx?: string;
    back?: string;
    installation?: string;
  }>(url.searchParams.get('state'));
  // Resolve in the workspace the transaction was issued for.
  const issued =
    linkState?.tx && entry.session
      ? memberOf(entry, entry.session, nonceOrganization(entry, linkState.tx))
      : undefined;
  const ctx = issued ? { ...entry, ...issued } : entry;
  const stated = backPath(linkState?.back);
  const integration = ctx.integrations[id!];
  if (!integration) return outcome(ctx, 'unknown-integration', { platform: id }, stated);

  const publicUrl = ctx.config.publicUrl;
  if (!publicUrl) return outcome(ctx, 'no-public-url', {}, stated);

  const request = ctx.fetch ?? fetch;
  const appId = url.searchParams.get('app');
  const transactionTarget = linkState?.tx
    ? await inspectNonce(ctx, linkState.tx, 'install', userId)
    : undefined;
  // Failed installs name the app, so installing again retries that one.
  const retry = { platform: id, appId: appId ?? transactionTarget };

  // OAuth's error redirect installs nothing; `access_denied` is the person cancelling.
  const error = url.searchParams.get('error');
  if (error)
    return error === 'access_denied'
      ? outcome(ctx, 'cancelled', retry, stated)
      : outcome(ctx, 'platform-error', { ...retry, error }, stated);

  // No state: the install began on the platform.
  if (!url.searchParams.has('state') && integration.app.installedApp && !operator)
    return platformInstall(req, ctx, integration, request);
  if (!transactionTarget || (appId && appId !== transactionTarget))
    return outcome(ctx, 'install-expired', retry, stated);
  if (!(await consumeNonce(ctx, linkState!.tx!, 'install', userId, transactionTarget)))
    return outcome(ctx, 'install-expired', retry, stated);

  const app = await ctx.store.get('app', appId ?? transactionTarget);
  // Install callback: state carries the one-time transaction and optional sibling link.

  const linked = linkState?.link ? await ctx.store.get('installation', linkState.link) : undefined;
  const target = app ?? (linked && (await linkedSibling(ctx, linked, id!)));
  // GitHub's setup redirect carries no app id; the installation webhook records the install.
  if (!target)
    return linkState && !linkState.link
      ? outcome(ctx, 'connected', { platform: id }, stated)
      : outcome(ctx, 'unknown-app', { platform: id }, stated);

  return bindInstall(req, ctx, integration, target, linked, stated, linkState?.installation);
}

/** Finish the install with the platform and bind the installation to `target` in this workspace. */
async function bindInstall(
  req: Request,
  ctx: AppsContext,
  integration: Integration,
  target: AgentApp,
  linked: Installation | undefined,
  stated: string | undefined,
  verifying: string | undefined,
): Promise<Response> {
  const id = integration.id;
  const request = ctx.fetch ?? fetch;
  const now = ctx.now?.() ?? Date.now();
  const publicUrl = ctx.config.publicUrl!;
  if (target.builtin && integration.app.builtin !== 'shared')
    return outcome(ctx, 'unknown-app', { platform: id }, stated);

  const back = stated ?? (target.builtin ? undefined : platformsPath(ctx, target.agent));

  const credentials = decryptSecret(ctx.config, target.credentials);
  const result = await integration.app
    .installCallback(req, {
      app: target,
      credentials,
      publicUrl,
      fetch: request,
      tokens: appTokens(ctx, integration.id),
      ...(verifying ? { installation: verifying } : {}),
    })
    .catch((error: unknown) => {
      if (error instanceof IntegrationError)
        return outcome(
          ctx,
          error.code,
          { platform: id, appId: target.id, error: error.error },
          back,
        );
      console.error(`coder server: installing ${target.id} failed`, error);

      return outcome(ctx, 'failed', { platform: id, appId: target.id }, back);
    });
  if (result instanceof Response) return result;

  const installationId = `${target.id}:${result.platformInstallId}`;
  const session = ctx.session;
  if (result.user && session && ctx.auth)
    await ctx.auth.link(session.user, id!, result.user.id, {
      organizations: session.organizations.map(o => o.id),
      ...(result.user.token ? { token: encryptSecret(ctx.config, result.user.token) } : {}),
    });

  const existing = await ctx.store.get('installation', installationId);
  let installation: Installation = {
    ...existing,
    id: installationId,
    app: target.id,
    integration: id!,
    account: result.account ?? existing?.account ?? linked?.account ?? { login: 'unknown' },
    ...(result.token ? { token: encryptSecret(ctx.config, result.token) } : {}),
    ...(result.installer ? { installer: result.installer } : {}),
    ...(result.self ? { self: result.self } : {}),
    ...(result.covers ? { covers: result.covers } : {}),
    createdAt: existing?.createdAt ?? now,
  };
  delete installation.deletedAt;
  delete installation.uninstalled;
  if (integration.repos) {
    const token = await integration.auth.token(
      result.token ? { ...installation, token: result.token } : installation,
      credentials,
      undefined,
      { fetch: request },
    );
    installation.repos = await integration.repos.list(installation, token, request);
  }

  const sibling = linked && !linked.deletedAt ? linked : undefined;
  if (sibling) installation = link(installation, sibling.integration, sibling.id);

  try {
    installation = (await storeInstallation(
      ctx.store,
      installationId,
      current =>
        result.covers === null ? { ...installation, covers: current?.covers ?? [] } : installation,
      now,
    ))!;
  } catch (error) {
    return error instanceof InstallationBoundError
      ? outcome(
          ctx,
          'installation-bound',
          { platform: id, account: installation.account.login },
          back,
        )
      : outcome(ctx, 'installation-taken', { platform: id }, back);
  }
  if (sibling) await ctx.store.put('installation', sibling.id, link(sibling, id!, installationId));
  if (installation.installer && integration.welcome)
    await greet(
      ctx,
      integration,
      target,
      credentials,
      result.platformInstallId,
      installation.installer,
    );

  return outcome(ctx, 'connected', { platform: id, account: installation.account.login }, back);
}

/** The integration's greeting to its installer, with the model step while nothing can run the agent. */
async function greet(
  ctx: AppsContext,
  integration: Integration,
  app: AgentApp,
  credentials: unknown,
  installationId: string,
  installer: string,
): Promise<void> {
  try {
    const [{ adapterContext, dashUrl }, { record, version }] = await Promise.all([
      import('../chat'),
      agentWithVersion(ctx.store, app.agent),
    ]);
    const { engine, usable } = await resolveEngine(ctx, {
      engine: record?.settings?.engine ?? version?.definition.engine,
      model: record?.settings?.model ?? version?.definition.model,
    }, ctx.session?.user.id);
    const adapter = adapterContext(
      ctx,
      integration,
      app,
      credentials,
      { id: installationId },
      await dashUrl(ctx),
    );
    const open = `${ctx.config.publicUrl!.replace(/\/$/, '')}${platformsPath(ctx, app.agent)}`;
    await integration.welcome!(adapter, installer, {
      open,
      ...(usable ? {} : { setup: await credentialFix(ctx, engine) }),
    });
  } catch (error) {
    console.error(`coder server: could not greet the installer of ${app.id}`, error);
  }
}
