/** Documents Wular reads from this server: client metadata (CIMD) and protected resource metadata (RFC 9728). */
import type { JWK } from 'jose';

import type { ServerContext } from '../context';
import { json } from '../routes/http';
import type { Params } from '../routes/match';

export const CALLBACK_PATH = '/api/auth/callback' as const;
export const WEB_CLIENT_PATH = '/.well-known/oauth-client.json' as const;
export const CLI_CLIENT_PATH = '/.well-known/oauth-cli-client.json' as const;
export const RESOURCE_PATH = '/.well-known/oauth-protected-resource' as const;
export const SCOPE = 'openid profile email offline_access organizations:read';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function oauthClientMetadata(publicUrl: string, jwks: { keys: JWK[] }) {
  return {
    client_id: `${publicUrl}${WEB_CLIENT_PATH}`,
    client_name: `Coder at ${new URL(publicUrl).host}`,
    redirect_uris: [`${publicUrl}${CALLBACK_PATH}`],
    post_logout_redirect_uris: [`${publicUrl}/?signed_out=1`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: 'ES256',
    jwks,
    scope: SCOPE,
  };
}

function cliClientMetadata(publicUrl: string) {
  return {
    client_id: `${publicUrl}${CLI_CLIENT_PATH}`,
    client_name: `Coder CLI for ${new URL(publicUrl).host}`,
    redirect_uris: ['http://127.0.0.1/callback'],
    grant_types: ['authorization_code', 'refresh_token', DEVICE_GRANT],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: SCOPE,
  };
}

function protectedResourceMetadata(publicUrl: string, issuer: string) {
  return {
    resource: new URL(publicUrl).origin,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: SCOPE.split(' '),
  };
}

function document(body: unknown) {
  const response = json(body);
  response.headers.set('cache-control', 'public, max-age=3600');

  return response;
}

export function webDocument(req: Request, ctx: ServerContext, params: Params, url: URL) {
  return document(oauthClientMetadata(ctx.config.publicUrl!, ctx.auth!.jwks));
}

export function cliDocument(req: Request, ctx: ServerContext, params: Params, url: URL) {
  return document(cliClientMetadata(ctx.config.publicUrl!));
}

export function resourceDocument(req: Request, ctx: ServerContext, params: Params, url: URL) {
  return document(protectedResourceMetadata(ctx.config.publicUrl!, ctx.auth!.issuer));
}
