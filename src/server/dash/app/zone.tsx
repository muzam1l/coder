'use client';

import { useEffect } from 'preact/hooks';

/** Records the browser's zone for server-rendered dates; until then they show in UTC. */
export function Zone() {
  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone && !document.cookie.includes(`tz=${encodeURIComponent(zone)}`))
      document.cookie = `tz=${encodeURIComponent(zone)}; path=/; max-age=31536000; samesite=lax`;
  }, []);
  return null;
}
