import './range-bar.css';

import { PRESETS, dayOf, type Range } from '@/utils/range';
import { CustomRange } from './custom-range';
import { linkOf, withSearch, type To } from '@/comps/nav/to';
import { iDown } from '@/comps/ui/icons';
import { Icon } from '@/comps/ui/icon';
import { BLANK } from '@/comps/frame/loading-card';
import { LoadingMenu } from '@/comps/ui/menu-items';
import { Segmented } from '@/comps/ui/segmented';
import type { Option } from '@/comps/ui/select';

const OPTIONS = Object.entries(PRESETS).map(([key, preset]): Option => [key, preset.short]);

/** Presets and a custom span, for the usage pages. */
export function RangeBar({
  range,
  to,
  tz,
}: {
  range: Range;
  /** The page the range applies to, with its own query. */
  to: To;
  tz: string;
}) {
  const today = dayOf(Date.now(), tz);
  return (
    <div class="range-line">
      <Segmented
        label="Range"
        options={OPTIONS}
        value={range.key}
        link={key => ({
          ...linkOf(to),
          search: withSearch(to.search, { range: key }),
          scroll: false,
        })}
      >
        <CustomRange
          page={to}
          from={range.from ?? dayOf(range.since, tz)}
          to={range.to ?? today}
          today={today}
          on={range.key === 'custom'}
        />
      </Segmented>
      <span class="muted">{range.label}</span>
    </div>
  );
}

/** A usage range bar before its page arrives; the range it shows comes with the page. */
export function LoadingRange() {
  return (
    <div class="range-line" aria-hidden="true">
      <Segmented label="Range" options={OPTIONS} value="">
        <LoadingMenu
          class="custom"
          summary={
            <>
              Custom
              <Icon d={iDown} />
            </>
          }
        />
      </Segmented>
      <span class="muted">{BLANK}</span>
    </div>
  );
}
