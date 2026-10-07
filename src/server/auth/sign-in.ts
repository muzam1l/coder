/** Prefix of Coder's cookies, so another app on the host never collides. */
export const COOKIE_PREFIX = 'coder';

export function safeReturnPath(candidate: string | null, origin: string): string {
  const value = candidate ?? '/dash';
  try {
    const target = new URL(value, origin);
    return target.origin === origin && !value.includes('\\') && !/^\/[/\\]/.test(target.pathname)
      ? `${target.pathname}${target.search}${target.hash}`
      : '/dash';
  } catch {
    return '/dash';
  }
}
