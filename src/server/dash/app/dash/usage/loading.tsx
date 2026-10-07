import '@/comps/ui/segmented.css';
import '@/app/dash/usage/range-bar.css';
import './usage.css';
import { HEADS } from '@/comps/frame/heads';
import { LoadingRange } from '@/app/dash/usage/range-bar';
import { Loading } from '@/comps/ui/card';
import { Page, PageHead } from '@/comps/frame/page-head';

export default function UsageLoading() {
  return (
    <Page>
      <PageHead {...HEADS.usage} />
      <LoadingRange />
      <Loading label="Loading usage" />
    </Page>
  );
}
