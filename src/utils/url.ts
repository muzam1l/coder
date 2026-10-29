/** Links to platform pages, checked before a task stores them and again before the dashboard renders them; free of dependencies so the dashboard imports it. */

/** `value` when it is an absolute `https:` URL on exactly one of `hosts`, with no credentials, port, whitespace or control characters. */
export function linkUrl(value: unknown, hosts: readonly string[]): string | undefined {
  if (typeof value !== 'string' || /[\s\p{Cc}\p{Cf}]/u.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  return url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    hosts.includes(url.hostname)
    ? url.href
    : undefined;
}
