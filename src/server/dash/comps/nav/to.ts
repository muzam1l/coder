import type { LinkProps } from '@wular/pnext/link';
import type { SearchInput } from '@wular/pnext/navigation';

/** A typed in-app link target: a route from the route list, its params and query. */
export type To = Pick<LinkProps, 'href' | 'params' | 'search'>;

/** The path a target resolves to, to compare with the address. */
export const pathOf = (to: To) => {
  const params: Partial<Record<string, unknown>> = to.params ?? {};
  return to.href.replace(/\[([^\]]+)\]/g, (_, key: string) =>
    encodeURIComponent(String(params[key] ?? '')),
  );
};

/** A query with some keys set on top of another. */
export function withSearch(base: SearchInput | undefined, set: Record<string, string>) {
  const search = new URLSearchParams(
    base instanceof URLSearchParams ? base : (base as Record<string, string> | undefined),
  );
  for (const [key, value] of Object.entries(set)) search.set(key, value);
  return search;
}
