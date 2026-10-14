import { HEADS } from '@/comps/frame/heads';
import { iAgent } from '@/comps/ui/icons';
import { Page } from '@/comps/frame/page-head';
import { LoadingToolbar } from '@/comps/frame/loading-card';
import { Loading } from '@/comps/ui/card';

/** The agents page before its list arrives. */
export default function AgentsLoading() {
  return (
    <Page>
      <LoadingToolbar
        head={HEADS.agents}
        search="Search agents"
        more
        action={{ label: 'New agent', icon: iAgent }}
      />
      <Loading label="Loading agents" />
    </Page>
  );
}
