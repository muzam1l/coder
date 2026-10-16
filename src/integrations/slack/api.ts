import type { AgentEvent } from '../types';

export function slackFetch(request: typeof fetch, installation?: string): typeof fetch {
  const users = new Map<string, Promise<Response>>();

  return (async (input, init) => {
    const outbound = new Request(input, init);
    if (
      new URL(outbound.url).origin !== 'https://slack.com' ||
      new URL(outbound.url).pathname !== '/api/users.info'
    )
      return request(input, init);
    const form = new URLSearchParams(await outbound.clone().text());
    const token =
      outbound.headers.get('authorization')?.replace(/^Bearer /, '') ?? form.get('token');
    const key = JSON.stringify([token, form.get('team_id') ?? installation, form.get('user')]);
    let pending = users.get(key);
    if (!pending) {
      pending = request(input, init)
        .then(async response => {
          const body = await response
            .clone()
            .json()
            .catch(() => undefined);
          if (!response.ok || body?.ok !== true) users.delete(key);
          return response;
        })
        .catch(error => {
          users.delete(key);
          throw error;
        });
      users.set(key, pending);
    }

    return (await pending).clone();
  }) as typeof fetch;
}

export async function canWriteSlack(
  event: AgentEvent,
  token: string,
  request: typeof fetch = fetch,
): Promise<boolean> {
  const team = event.within ?? event.installationId;
  if (!team || !event.actor.id) throw new Error('Slack event has no workspace or actor');
  const response = await request('https://slack.com/api/users.info', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ user: event.actor.id, team_id: team }),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  const body = (await response.json()) as {
    ok?: boolean;
    user?: {
      id?: string;
      team_id?: string;
      deleted?: boolean;
      is_bot?: boolean;
      is_restricted?: boolean;
      is_ultra_restricted?: boolean;
      is_external?: boolean;
      enterprise_user?: { teams?: string[] };
    };
  };
  const user = body.user;
  if (!response.ok || body.ok !== true || !user)
    throw new Error('Slack returned no valid workspace member');

  return (
    user.id === event.actor.id &&
    user.deleted === false &&
    user.is_bot === false &&
    user.is_restricted === false &&
    user.is_ultra_restricted === false &&
    (user.is_external === undefined || user.is_external === false) &&
    (user.team_id === team ||
      (Array.isArray(user.enterprise_user?.teams) && user.enterprise_user.teams.includes(team)))
  );
}
