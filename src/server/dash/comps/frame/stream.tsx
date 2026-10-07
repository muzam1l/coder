import type { ComponentChildren } from 'preact';
import { Suspense } from 'preact/compat';

import { signedOut } from '@/api/load';
import { Card } from '@/comps/ui/card';
import { reasonText } from '@/utils/format';

/** A section that waits for `load`, under the route's loading frame; a failure stays inside it. */
export async function Settle({ load }: { load: () => Promise<ComponentChildren> }) {
  try {
    return await load();
  } catch (error) {
    return <SectionFailure error={error} />;
  }
}

/** A section that streams in behind its loading box; `load` runs when it renders, and a failure stays inside. */
export function Stream({
  fallback,
  load,
}: {
  fallback: ComponentChildren;
  load: () => Promise<ComponentChildren>;
}) {
  return (
    <Suspense fallback={fallback}>
      <Settle load={load} />
    </Suspense>
  );
}

function SectionFailure({ error }: { error: unknown }) {
  return (
    <Card tone="danger" title="Could not load this">
      <p class="body prose">
        {signedOut(error) ? (
          <>
            Your session ended.{' '}
            <a class="link" href="/login">
              Sign in again
            </a>
            .
          </>
        ) : (
          reasonText(error)
        )}
      </p>
    </Card>
  );
}
