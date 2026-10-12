import { HEADS } from '@/comps/frame/heads';
import { Back, Page, PageHead } from '@/comps/frame/page-head';
import { Loading } from '@/comps/ui/card';
import { Icon } from '@/comps/ui/icon';
import { iPlus } from '@/comps/ui/icons';

export default function NewAgentLoading() {
  return (
    <Page>
      <PageHead
        {...HEADS.newAgent}
        back={<Back href="/dash/agents" params={{}} label="Agents" />}
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
