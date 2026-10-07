import { Loading } from '@/comps/ui/card';
import { Page, PageHead } from '@/comps/frame/page-head';

export default function AccountLoading() {
  return (
    <Page>
      <PageHead title="Account" lead={' '} />
      <Loading label="Loading account" />
    </Page>
  );
}
