import '@/comps/ui/segmented.css';
import '@/app/dash/usage/range-bar.css';
import { LoadingRange } from '@/app/dash/usage/range-bar';
import { Stat, Stats } from '@/app/dash/usage/stats';
import { Card, Loading } from '@/comps/ui/card';
import { BLANK } from '@/comps/frame/loading-card';

/** The usage tab's shape before its numbers arrive: totals, the day chart and the two breakdowns, blank. */
export default function AgentUsageLoading() {
  return (
    <>
      <LoadingRange />
      <Stats label="Totals">
        {['Tasks', 'Runner time', 'Tokens', 'Average task'].map(label => (
          <Stat key={label} label={label} value={BLANK} />
        ))}
      </Stats>
      <Card title="Tasks per day">
        <Loading label="Loading usage" h={232} />
      </Card>
      <div class="grid-2">
        <Card title="By installation">
          <Loading label="Loading installations" h={173} />
        </Card>
        <Card title="By engine">
          <Loading label="Loading engines" h={173} />
        </Card>
      </div>
    </>
  );
}
