import { HEADS } from '@/comps/frame/heads';
import { Page, PageHead } from '@/comps/frame/page-head';
import { OrgBack } from '@/comps/nav/org';
import { Loading } from '@/comps/ui/card';
import { Button } from '@/comps/ui/button';
import { iPlus } from '@/comps/ui/icons';

export default function NewAgentLoading() {
  return (
    <Page>
      <PageHead
        {...HEADS.newAgent}
        back={<OrgBack href="/dash/[org]/agents" label="Agents" />}
        actions={
          <>
            <Button variant="outline" disabled>
              Import from repo
            </Button>
            <Button leftIcon={iPlus} disabled>
              Create agent
            </Button>
          </>
        }
      />
      <Loading label="Loading editor" h={640} />
    </Page>
  );
}
