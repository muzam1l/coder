import { useEffect, useRef, useState } from 'preact/hooks';

const atEnd = () => innerHeight + scrollY >= document.documentElement.scrollHeight - 48;
const toEnd = () => scrollTo({ top: document.documentElement.scrollHeight });

/** Keeps the page at its end as it grows while the reader stays there; `follow` takes it there. */
export function useFollowEnd(start = false) {
  const [following, setFollowing] = useState(start);
  const current = useRef(start);
  current.current = following;

  useEffect(() => {
    const onScroll = () => setFollowing((current.current = atEnd()));
    const observer = new ResizeObserver(() => current.current && toEnd());
    observer.observe(document.body);
    addEventListener('scroll', onScroll, { passive: true });
    if (current.current) toEnd();
    onScroll();

    return () => {
      observer.disconnect();
      removeEventListener('scroll', onScroll);
    };
  }, []);

  const follow = () => {
    current.current = true;
    setFollowing(true);
    toEnd();
  };

  return { following, follow };
}
