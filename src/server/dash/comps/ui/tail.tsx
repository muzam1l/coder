import './tail.css';
import type { RefObject } from 'preact';

import { Button } from './button';
import { Loading } from './card';

/** Below the rows: what is loading, what failed, and the mark that pulls in the next page. */
export function Tail({
  sentinel,
  more,
  busy,
  error,
  retry,
  noun,
}: {
  sentinel: RefObject<HTMLElement>;
  more: boolean;
  busy: boolean;
  error: string;
  retry: () => void;
  noun: string;
}) {
  if (!more && !error) return null;
  return (
    <div class={error ? 'tail err' : 'tail'} ref={sentinel as never} role="status">
      {error ? (
        <>
          {error}{' '}
          <Button variant="ghost" size="sm" onClick={retry}>
            Retry
          </Button>
        </>
      ) : busy ? (
        <Loading label={`Loading more ${noun}`} inline late />
      ) : null}
    </div>
  );
}
