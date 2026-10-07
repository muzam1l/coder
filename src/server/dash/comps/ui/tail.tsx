import './tail.css';
import type { RefObject } from 'preact';

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
          <button type="button" class="btn ghost sm" onClick={retry}>
            Retry
          </button>
        </>
      ) : busy ? (
        <Loading label={`Loading more ${noun}`} inline />
      ) : null}
    </div>
  );
}
