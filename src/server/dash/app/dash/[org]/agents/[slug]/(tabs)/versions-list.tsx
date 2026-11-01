'use client';

import { client } from '@/utils/client';
import { formatDate } from '@/utils/format';
import { usePaged } from '@/utils/paged';
import type { VersionRow, Paged } from '@coder/client/types';
import { Badge } from '@/comps/ui/badge';
import { LIST_PAGE } from '@/utils/paged';
import { Tail } from '@/comps/ui/tail';
import { Button } from '@/comps/ui/button';
import { useState } from 'preact/hooks';

/** Rows the history shows before Show more. */
const FOLDED_ROWS = 5;

/** Version history newest first, folded to the latest few; open, older versions load as the page scrolls. */
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
  const [open, setOpen] = useState(false);
  const list = usePaged<VersionRow>({
    name: `versions|${agent}`,
    fetchPage: cursor => client.agents.versions(agent, { cursor, limit: LIST_PAGE }),
    query: '',
    first,
    initial: '',
    paused: !open,
  });
  const folds = list.rows.length > FOLDED_ROWS || list.more;
  const rows = open ? list.rows : list.rows.slice(0, FOLDED_ROWS);

  return (
    <>
      <ul class="versions">
        {rows.map(version => (
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
      {folds ? (
        <Button
          variant="ghost"
          size="sm"
          class="versions-more"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : 'Show more'}
        </Button>
      ) : null}
    </>
  );
}
