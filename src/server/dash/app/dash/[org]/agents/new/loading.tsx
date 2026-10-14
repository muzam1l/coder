import { HEADS } from '@/comps/frame/heads';
import { Page, PageHead } from '@/comps/frame/page-head';
import { OrgBack } from '@/comps/nav/org';
import { Loading } from '@/comps/ui/card';
import { Icon } from '@/comps/ui/icon';
import { iPlus } from '@/comps/ui/icons';

export default function NewAgentLoading() {
  return (
    <Page>
      <PageHead
        {...HEADS.newAgent}
        back={<OrgBack href="/dash/[org]/agents" label="Agents" />}
        actions={
          <>
            <button type="button" class="btn outline" disabled>
              Import from repo
            </button>
            <button type="button" class="btn" disabled>
              <Icon d={iPlus} />
              Create agent
            </button>
          </>
        }
      />
      <Loading label="Loading editor" h={640} />
    </Page>
  );
}
