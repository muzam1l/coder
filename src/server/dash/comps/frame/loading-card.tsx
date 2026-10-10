import { iDown, iSearch } from '@/comps/ui/icons';
import { Card, Loading } from '@/comps/ui/card';
import { Icon } from '@/comps/ui/icon';
import { Toolbar } from '@/comps/ui/toolbar';

export const BLANK = ' ';

/** `Loading` inside the box its data fills, titled as that box. */
export function LoadingCard({ title, label, h }: { title?: string; label: string; h?: number }) {
  return (
    <Card title={title}>
      <Loading label={label} h={h} />
    </Card>
  );
}

/** A list's toolbar while the list loads: the same title and controls, inert until the list is live. */
export function LoadingToolbar({
  head,
  search,
  selects = [],
  more,
  action,
}: {
  head?: { title: string; lead?: string };
  search: string;
  selects?: string[];
  /** A disabled more-filters button after the selects. */
  more?: boolean;
  /** The primary button. */
  action?: { label: string; icon: string };
}) {
  return (
    <Toolbar
      head={head}
      action={
        action ? (
          <button type="button" class="btn" disabled>
            <Icon d={action.icon} />
            {action.label}
          </button>
        ) : undefined
      }
    >
      <label class="search" aria-hidden="true">
        <Icon d={iSearch} />
        <input type="search" placeholder={search} disabled tabIndex={-1} />
      </label>
      {selects.map(label => (
        <span key={label} class="select" aria-hidden="true">
          <button type="button" disabled tabIndex={-1}>
            <span class="grow">{label}</span>
            <Icon d={iDown} />
          </button>
        </span>
      ))}
      {more ? (
        <span class="menu filter-more" aria-hidden="true">
          <button type="button" class="field-btn" disabled tabIndex={-1}>
            Filter
          </button>
        </span>
      ) : null}
    </Toolbar>
  );
}
