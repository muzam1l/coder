import { Button } from '@/comps/ui/button';
import { Card, Loading } from '@/comps/ui/card';
import { LoadingFilter } from '@/comps/ui/filter';
import { Select } from '@/comps/ui/select';
import { Search, Toolbar } from '@/comps/ui/toolbar';

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
          <Button disabled leftIcon={action.icon}>
            {action.label}
          </Button>
        ) : undefined
      }
    >
      <Search label={search} disabled />
      {selects.map(label => (
        <Select key={label} label={label} options={[['', label]]} disabled />
      ))}
      {more ? <LoadingFilter /> : null}
    </Toolbar>
  );
}
