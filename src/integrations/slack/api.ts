import type { AgentEvent } from '../types';

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
