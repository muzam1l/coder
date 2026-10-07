'use client';

import { useEffect } from 'preact/hooks';

/** `serve` opens /dash#token=…: the fragment never reaches the server, and it leaves history before the form posts it. */
export function TokenFromHash() {
  useEffect(() => {
    const token = /(?:^|&)token=([^&]+)/.exec(location.hash.slice(1))?.[1];
    if (!token) return;
    history.replaceState(null, '', location.pathname + location.search);
    const form = document.getElementById('token-form') as HTMLFormElement | null;
    if (!form) return;
    (form.elements.namedItem('token') as HTMLInputElement).value = decodeURIComponent(token);
    form.submit();
  }, []);
  return null;
}
