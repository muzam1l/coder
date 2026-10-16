import { createHmac } from 'node:crypto';
import { safeEqual } from '../../utils/crypto';
import type { AgentEvent } from '../types';

/** Linear's webhook check: an HMAC of the body under the app's secret, sent within the last minute. */
export function verifyLinearWebhook(
  raw: string,
  signature: string | null,
  secret: string | undefined,
  now = Date.now(),
): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  if (!safeEqual(Buffer.from(signature, 'hex'), expected)) return false;
  const sent = (JSON.parse(raw) as { webhookTimestamp?: unknown }).webhookTimestamp;
  return typeof sent === 'number' && Math.abs(now - sent) <= 60_000;
}

export async function canWriteLinear(
  event: AgentEvent,
  token: string,
  request: typeof fetch = fetch,
): Promise<boolean> {
  if (!event.actor.id || !event.installationId)
    throw new Error('Linear event has no actor or workspace');
  const response = await request('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query:
        'query CoderWorkspaceMember($id: String!) { user(id: $id) { id active guest app organization { id } } }',
      variables: { id: event.actor.id },
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  const body = (await response.json()) as {
    errors?: unknown[];
    data?: {
      user?: {
        id?: string;
        active?: boolean;
        guest?: boolean;
        app?: boolean;
        organization?: { id?: string };
      };
    };
  };
  const user = body.data?.user;
  if (
    !response.ok ||
    (body.errors !== undefined && (!Array.isArray(body.errors) || body.errors.length > 0)) ||
    !user
  )
    throw new Error('Linear returned no valid workspace member');

  return (
    user.id === event.actor.id &&
    user.active === true &&
    user.guest === false &&
    user.app === false &&
    user.organization?.id === event.installationId
  );
}
