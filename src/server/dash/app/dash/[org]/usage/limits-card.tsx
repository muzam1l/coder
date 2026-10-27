import './limits-card.css';
import type { WorkspaceLimits } from '@coder/client/types';
import { Button } from '@/comps/ui/button';
import { Card } from '@/comps/ui/card';

/** The bar's fill and color: green under 60%, yellow from 60%, red from 90%. */
const meter = ({ used, limit }: { used: number; limit: number }) => {
  const share = used / limit;

  return {
    '--used': `${Math.min(100, share * 100)}%`,
    '--tone': share >= 0.9 ? 'var(--bad)' : share >= 0.6 ? 'var(--warn)' : 'var(--ok)',
  };
};

/** This month's usage against the workspace's limits, with its plan and the way to more; the range above does not apply. */
export function LimitsCard({ limits }: { limits?: WorkspaceLimits }) {
  if (!limits?.cpuMinutes && !limits?.runners) return null;
  const { cpuMinutes, runners, plan, plansUrl } = limits;

  return (
    <Card
      title={plan ? `${plan} plan` : 'Limits'}
      actions={
        plansUrl ? (
          <Button href={plansUrl} size="sm">
            Upgrade
          </Button>
        ) : null
      }
    >
      <div class="body limits">
        {cpuMinutes ? (
          <div>
            <span>CPU minutes this month</span>
            <strong>
              {Math.floor(cpuMinutes.used)} of {cpuMinutes.limit}
            </strong>
            <i style={meter(cpuMinutes)} />
          </div>
        ) : null}
        {runners ? (
          <div>
            <span>Own runners</span>
            <strong>
              {runners.used} of {runners.limit}
            </strong>
            <i style={meter(runners)} />
          </div>
        ) : null}
      </div>
    </Card>
  );
}
