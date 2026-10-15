'use client';

import { useEffect, useState } from 'preact/hooks';

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Records the browser's zone for server-rendered dates; until then they show in UTC. */
export function Zone() {
  useEffect(() => {
    const zone = browserZone();
    if (zone && !document.cookie.includes(`tz=${encodeURIComponent(zone)}`))
      document.cookie = `tz=${encodeURIComponent(zone)}; path=/; max-age=31536000; samesite=lax`;
  }, []);
  return null;
}

/** The viewer's zone for an island's dates: the server's `tz` while it hydrates, then the browser's. */
export function useZone(tz: string) {
  const [zone, setZone] = useState(tz);
  useEffect(() => setZone(browserZone() || tz), []);
  return zone;
}
