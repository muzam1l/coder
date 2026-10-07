import { type Params } from '../routes/match';
import { decryptSecret, encryptSecret } from '../store/secrets';
import { type Installation } from '../../agent/types';
import { consumeNonce, inspectNonce } from '../auth/nonce';
import { encodeJson } from '../../utils/base64url';
import { decodeParam, redirect } from '../routes/http';
import {
  type AppsContext,
  OPERATOR,
  page,
  link,
  linkedSibling,
  connectLinks,
  backPath,
} from './platform';

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
  const integration = ctx.integrations[id!];
  if (!integration)
    return page(`Unknown integration "${id}"; run coder agent integrations list to see them`, 404);

  const publicUrl = ctx.config.publicUrl;
  if (!publicUrl)
    return page(
      'PUBLIC_URL is not set on this server; set it to the address platforms should call and restart',
      400,
    );

  const request = ctx.fetch ?? fetch;
  const now = ctx.now?.() ?? Date.now();
  const linkState = decodeParam<{
    link?: string;
    tx?: string;
    back?: string;
  }>(url.searchParams.get('state'));
  const appId = url.searchParams.get('app');
  const transactionTarget = linkState?.tx
    ? await inspectNonce(ctx, linkState.tx, 'install', userId)
    : undefined;
  if (!transactionTarget || (appId && appId !== transactionTarget))
    return page('This installation link is invalid, expired, or already used', 403);

  const app = await ctx.store.get('app', appId ?? transactionTarget);
  if (!app) return page('This app is not known to this server; create it first', 400);

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
  const integration = ctx.integrations[id!];
  if (!integration)
    return page(`Unknown integration "${id}"; run coder agent integrations list to see them`, 404);

  const publicUrl = ctx.config.publicUrl;
  if (!publicUrl)
    return page(
      'PUBLIC_URL is not set on this server; set it to the address platforms should call and restart',
      400,
    );

  const request = ctx.fetch ?? fetch;
  const now = ctx.now?.() ?? Date.now();
  const linkState = decodeParam<{
    link?: string;
    tx?: string;
    back?: string;
  }>(url.searchParams.get('state'));
  const appId = url.searchParams.get('app');
  const transactionTarget = linkState?.tx
    ? await inspectNonce(ctx, linkState.tx, 'install', userId)
    : undefined;
  if (!transactionTarget || (appId && appId !== transactionTarget))
    return page('This installation link is invalid, expired, or already used', 403);
  if (!(await consumeNonce(ctx, linkState!.tx!, 'install', userId, transactionTarget)))
    return page('This installation link is invalid, expired, or already used', 403);

  const app = await ctx.store.get('app', appId ?? transactionTarget);
  if (false) return page('This app is not known to this server; create it first', 400);
  // Install callback: state carries the one-time transaction and optional sibling link.

  const linked = linkState?.link ? await ctx.store.get('installation', linkState.link) : undefined;
  const target = app ?? (linked && (await linkedSibling(ctx, linked, id!)));
  // GitHub's setup redirect carries no app id; the installation webhook records the install.
  if (!target)
    return linkState && !linkState.link
      ? page('Connected.')
      : page('This install does not match any app on this server; create the app first', 400);

  const credentials = decryptSecret(ctx.config, target.credentials);
  const result = await integration.app
    .installCallback(req, {
      app: target,
      credentials,
      publicUrl,
      fetch: request,
      connect: connectLinks(ctx, target, publicUrl),
    })
    .catch(error => page(error instanceof Error ? error.message : String(error), 400));
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
    createdAt: existing?.createdAt ?? now,
  };
  delete installation.deletedAt;

  const sibling = linked && !linked.deletedAt ? linked : undefined;
  if (sibling) installation = link(installation, sibling.integration, sibling.id);

  try {
    await ctx.store.put('installation', installationId, installation);
  } catch {
    return page(
      `This ${id} installation is already connected to another workspace; disconnect it there first`,
      409,
    );
  }
  if (sibling) await ctx.store.put('installation', sibling.id, link(sibling, id!, installationId));
  if (integration.renew) {
    const failed = await (
      await import('../chat')
    )
      .renewInstallation({ ...ctx, fetch: request }, target, result.platformInstallId)
      .then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    if (failed)
      return page(
        `Connected, but ${id} did not start sending events yet. ${failed}. Coder tries again within the hour.`,
        502,
      );
  }

  const back = backPath(linkState?.back);

  return back ? redirect(`${publicUrl.replace(/\/$/, '')}${back}`) : result.response;
}
