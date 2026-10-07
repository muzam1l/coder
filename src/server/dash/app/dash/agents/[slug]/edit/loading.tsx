import { iLeft } from '@/comps/ui/icons';
import { BLANK, LoadingCard } from '@/comps/frame/loading-card';
import { LoadingHero } from '@/app/dash/agents/agent/hero';
import { Page } from '@/comps/frame/page-head';
import { Icon } from '@/comps/ui/icon';

export default function AgentEditLoading() {
  return (
    <Page>
      <LoadingHero
        back={
          <span class="back" aria-hidden="true">
            <Icon d={iLeft} />
            {BLANK}
          </span>
        }
        actions={
          <>
            <button type="button" class="btn ghost" disabled>
              Cancel
            </button>
            <button type="button" class="btn" disabled>
              Publish new version
            </button>
          </>
        }
      />
      <LoadingCard label="Loading editor" h={472} />
    </Page>
  );
}
