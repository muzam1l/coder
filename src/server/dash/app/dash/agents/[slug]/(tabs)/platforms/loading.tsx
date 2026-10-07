import { LoadingCard } from '@/comps/frame/loading-card';

export const Lead = () => (
  <p class="tab-lead">
    Each platform gets its own app named after the agent. Install an app wherever the agent should
    work.
  </p>
);

/** The platforms tab before its apps arrive. */
export default function PlatformsLoading() {
  return (
    <>
      <Lead />
      <LoadingCard label="Loading platforms" />
    </>
  );
}
