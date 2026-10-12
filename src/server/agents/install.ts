import { type Params } from '../routes/match';
import { decryptSecret, encryptSecret } from '../store/secrets';
import { InstallationBoundError, type Store } from '../store/types';
import { checkBinding } from '../store/memory';
import { type Installation } from '../../agent/types';
import { IntegrationError } from '../../integrations/types';
import { consumeNonce, inspectNonce } from '../auth/nonce';
import { encodeJson } from '../../utils/base64url';
import { decodeParam, redirect } from '../routes/http';
import {
  type AppsContext,
  OPERATOR,
  outcome,
  platformsPath,
  link,
  linkedSibling,
  connectLinks,
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
  if (!/^[a-z0-9_-]+$/.test(url.pathname.split('/')[2]!)) return undefined;

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

export async function completeInstall(
  req: Request,
  ctx: AppsContext,
  params: Params,
  url: URL,
): Promise<Response | undefined> {
  const id = params.id!;
  const operator = ctx.operatorApp ?? false;
  if (!/^[a-z0-9_-]+$/.test(url.pathname.split('/')[2]!)) return undefined;

  const userId = operator ? OPERATOR : (ctx.session?.user.id ?? 'anonymous');
  const linkState = decodeParam<{
    link?: string;
    tx?: string;
    back?: string;
  }>(url.searchParams.get('state'));
  const stated = backPath(linkState?.back);
  const integration = ctx.integrations[id!];
  if (!integration) return outcome(ctx, 'unknown-integration', { platform: id }, stated);

  const publicUrl = ctx.config.publicUrl;
  if (!publicUrl) return outcome(ctx, 'no-public-url', {}, stated);

  const request = ctx.fetch ?? fetch;
  const now = ctx.now?.() ?? Date.now();
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
  if (target.builtin && integration.app.builtin !== 'shared')
    return outcome(ctx, 'unknown-app', { platform: id }, stated);

  const back = stated ?? (target.builtin ? undefined : platformsPath(target.agent));

  const credentials = decryptSecret(ctx.config, target.credentials);
  const result = await integration.app
    .installCallback(req, {
      app: target,
      credentials,
      publicUrl,
      fetch: request,
      connect: connectLinks(ctx, target, publicUrl),
    })
    .catch((error: unknown) =>
      error instanceof IntegrationError
        ? outcome(ctx, error.code, { platform: id, appId: target.id, error: error.error }, back)
        : outcome(ctx, 'failed', { platform: id, appId: target.id }, back),
    );
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
    ...(result.covers ? { covers: result.covers } : {}),
    createdAt: existing?.createdAt ?? now,
  };
  delete installation.deletedAt;

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
  if (integration.renew) {
    const failed = await (
      await import('../chat')
    )
      .renewInstallation({ ...ctx, fetch: request }, target, result.platformInstallId)
      .then(
        () => false,
        () => true,
      );
    if (failed)
      return outcome(
        ctx,
        'renew-failed',
        { platform: id, account: installation.account.login },
        back,
      );
  }

  return outcome(
    ctx,
    'connected',
    {
      platform: id,
      account: installation.account.login,
      connect: Object.keys(result.connect ?? {}),
      link: result.connect ? installationId : undefined,
    },
    back,
  );
}
