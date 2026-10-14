import { iUpload } from '@/comps/ui/icons';
import { LoadingCard } from '@/comps/frame/loading-card';
import { LoadingHero } from '@/app/dash/[org]/agents/agent/hero';
import { LoadingBack, Page } from '@/comps/frame/page-head';
import { Button } from '@/comps/ui/button';

export default function AgentEditLoading() {
  return (
    <Page>
      <LoadingHero
        back={<LoadingBack />}
        actions={
          <>
            <Button variant="ghost" disabled>
              Cancel
            </Button>
            <Button leftIcon={iUpload} disabled>
              Publish new version
            </Button>
          </>
        }
      />
      <LoadingCard label="Loading editor" h={472} />
    </Page>
  );
}
