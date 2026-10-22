import { LoadingBack, Page, PageHead } from '@/comps/frame/page-head';
import { BLANK, LoadingCard } from '@/comps/frame/loading-card';

/** An app's page before its installs arrive. */
export default function AgentAppLoading() {
  return (
    <Page>
      <PageHead back={<LoadingBack />} title={BLANK} lead={BLANK} />
      <LoadingCard title="Installed on" label="Loading app" />
    </Page>
  );
}
