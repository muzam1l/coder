/** Where Settings links back to, kept out of the address; Settings forgets it once shown. */
export const BACK_COOKIE = 'coder-back';

export type Remembered = { path: string; label?: string };

/** The remembered page from a cookie header, when it is a dashboard page. */
export function rememberedBack(cookies: string): Remembered | null {
  const value = new RegExp(`(?:^|; )${BACK_COOKIE}=([^;]*)`).exec(cookies)?.[1];
  try {
    const back = value && (JSON.parse(decodeURIComponent(value)) as Remembered);
    return back && typeof back.path === 'string' && back.path.startsWith('/dash/') ? back : null;
  } catch {
    return null;
  }
}
