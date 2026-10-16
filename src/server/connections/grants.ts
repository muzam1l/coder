import { visibleConnections, type ConnectionContext } from './records';

export async function connectionGrants(
  ctx: ConnectionContext,
  requester?: string,
  allowed?: string[],
): Promise<string[]> {
  const rows = await visibleConnections(ctx, requester);

  return rows
    .filter(connection => allowed === undefined || allowed.includes(connection.id))
    .map(connection => connection.id);
}
