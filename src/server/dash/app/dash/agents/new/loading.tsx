import { HEADS } from '@/comps/frame/heads';
import { LoadingCard } from '@/comps/frame/loading-card';
import { Back, Page, PageHead } from '@/comps/frame/page-head';

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
              Create agent
            </button>
          </>
        }
      />
      <LoadingCard label="Loading editor" h={640} />
    </Page>
  );
}
