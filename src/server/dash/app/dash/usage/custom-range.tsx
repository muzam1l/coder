'use client';

import { iDown } from '@/comps/ui/icons';
import { useRouter } from '@wular/pnext/navigation/client';
import { withSearch, type To } from '@/comps/nav/to';
import { Icon } from '@/comps/ui/icon';
import { useId } from 'preact/hooks';

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
  const id = useId();

  return (
    <span class={on ? 'menu custom on' : 'menu custom'}>
      <button popovertarget={id} type="button">
        Custom
        <Icon d={iDown} />
      </button>
      <form
        id={id}
        class="pop date-pop"
        popover="auto"
        onSubmit={event => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          const [start, end] = [String(values.get('from')), String(values.get('to'))].sort();

          event.currentTarget.hidePopover();
          nav.push(page.href, {
            params: page.params,
            search: withSearch(page.search, { from: String(start), to: String(end) }),
            scroll: false,
          });
        }}
      >
        <label class="field">
          <span>From</span>
          <input type="date" name="from" defaultValue={from} max={today} required />
        </label>
        <label class="field">
          <span>To</span>
          <input type="date" name="to" defaultValue={to} max={today} required />
        </label>
        <button class="btn sm">Apply</button>
      </form>
    </span>
  );
}
