import '@/comps/ui/segmented.css';
import './range-bar.css';

import { Link } from '@wular/pnext/link';
import { PRESETS, dayOf, type Range } from '@/utils/range';
import { CustomRange } from './custom-range';
import { withSearch, type To } from '@/comps/nav/to';
import { iDown } from '@/comps/ui/icons';
import { Icon } from '@/comps/ui/icon';
import { BLANK } from '@/comps/frame/loading-card';

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
      <div class="seg-btns" role="group" aria-label="Range">
        {Object.entries(PRESETS).map(([key, preset]) => (
          <Link
            key={key}
            {...to}
            search={withSearch(to.search, { range: key })}
            scroll={false}
            aria-current={range.key === key ? 'page' : undefined}
          >
            {preset.short}
          </Link>
        ))}
        <CustomRange
          page={to}
          from={range.from ?? dayOf(range.since, tz)}
          to={range.to ?? today}
          today={today}
          on={range.key === 'custom'}
        />
      </div>
      <span class="muted">{range.label}</span>
    </div>
  );
}

/** A usage range bar before its page arrives; the range it shows comes with the page. */
export function LoadingRange() {
  return (
    <div class="range-line" aria-hidden="true">
      <div class="seg-btns">
        {Object.values(PRESETS).map(preset => (
          <a key={preset.short}>{preset.short}</a>
        ))}
        <span class="menu custom">
          <button type="button" disabled tabIndex={-1}>
            Custom
            <Icon d={iDown} />
          </button>
        </span>
      </div>
      <span class="muted">{BLANK}</span>
    </div>
  );
}
