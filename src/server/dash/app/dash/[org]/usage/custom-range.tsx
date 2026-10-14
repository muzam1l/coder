'use client';

import { iDown } from '@/comps/ui/icons';
import { useRouter } from '@wular/pnext/navigation/client';
import { linkOf, withSearch, type To } from '@/comps/nav/to';
import { Icon } from '@/comps/ui/icon';
import { Button } from '@/comps/ui/button';
import { Field } from '@/comps/ui/field';
import { Menu } from '@/comps/ui/menu';

/** Custom from and to dates; applying them moves the page to that range. */
export function CustomRange({
  page,
  from,
  to,
  today,
  on,
}: {
  /** The page's path and query, without range parameters. */
  /** The page the range applies to. */
  page: To;
  from: string;
  to: string;
  today: string;
  on: boolean;
}) {
  const nav = useRouter();

  return (
    <Menu
      class={on ? 'custom on' : 'custom'}
      align="left"
      summary={
        <>
          Custom
          <Icon d={iDown} />
        </>
      }
    >
      <form
        class="date-pop"
        onSubmit={event => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          const [start, end] = [String(values.get('from')), String(values.get('to'))].sort();

          event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
          nav.push(page.href, {
            params: linkOf(page).params,
            search: withSearch(page.search, { from: String(start), to: String(end) }),
            scroll: false,
          });
        }}
      >
        <Field label="From">
          <input type="date" name="from" defaultValue={from} max={today} required />
        </Field>
        <Field label="To">
          <input type="date" name="to" defaultValue={to} max={today} required />
        </Field>
        <Button type="submit" size="sm" data-keep>
          Apply
        </Button>
      </form>
    </Menu>
  );
}
