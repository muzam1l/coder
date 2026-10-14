'use client';

import { client } from '@/utils/client';
import { formatDate } from '@/utils/format';
import { usePaged } from '@/utils/paged';
import type { VersionRow, Paged } from '@coder/client/types';
import { Badge } from '@/comps/ui/badge';
import { LIST_PAGE } from '@/utils/paged';
import { Tail } from '@/comps/ui/tail';

/** Version history newest first; older versions load as the page scrolls. */
export function VersionsList({
  agent,
  current,
  first,
  tz,
}: {
  agent: string;
  current: number;
  first: Paged<VersionRow>;
  tz: string;
}) {
  const list = usePaged<VersionRow>({
    name: `versions|${agent}`,
    fetchPage: cursor => client.agents.versions(agent, { cursor, limit: LIST_PAGE }),
    query: '',
    first,
    initial: '',
  });
  return (
    <>
      <ul class="versions">
        {list.rows.map(version => (
          <li key={version.version}>
            <Badge tone={version.version === current ? 'acc' : undefined}>v{version.version}</Badge>
            <span class="muted grow">
              {[
                version.version === current && 'current',
                version.importedFrom !== 'upload' &&
                  version.importedFrom &&
                  `${version.importedFrom}${version.commit ? ` at ${version.commit.slice(0, 7)}` : ''}`,
              ]
                .filter(Boolean)
                .join(', ')}
            </span>
            <span class="when">{formatDate(version.createdAt, tz)}</span>
          </li>
        ))}
      </ul>
      <Tail noun="versions" {...list} />
    </>
  );
}
