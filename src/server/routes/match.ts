import type { ServerContext } from '../context';
import { notAllowed } from './http';

export type Params = Record<string, string>;
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Names<P extends string> = P extends `${infer Head}/${infer Tail}`
  ? Names<Head> | Names<Tail>
  : P extends `:${infer Name}`
    ? Name
    : P extends '*'
      ? '*'
      : never;
type Values<P extends string> = string extends P ? Params : Record<Names<P>, string>;
type Arguments<P extends string = string> = [Request, ServerContext, Values<P>, URL];
export type Handler<P extends string = string> = (
  ...args: Arguments<P>
) => Response | undefined | Promise<Response | undefined>;
export type Guard = (
  ...args: Arguments
) => ServerContext | Response | Promise<ServerContext | Response>;
export type Route = { method: Method; pattern: string; handler: Handler; guard?: Guard };

const METHODS: Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function route<P extends string>(
  method: Method,
  pattern: P,
  handler: Handler<P>,
  guard?: Guard,
): Route {
  return { method, pattern, handler: handler as unknown as Handler, ...(guard ? { guard } : {}) };
}

/** Routes under `prefix`; `guard` applies to entries without their own. */
export function group(prefix: string, routes: readonly Route[], guard?: Guard): Route[] {
  return routes.map(entry => ({
    ...entry,
    pattern: prefix + entry.pattern,
    ...(guard && !entry.guard ? { guard } : {}),
  }));
}

/** A handler that owns everything under `prefix`, any method: SSR pages and third-party handlers. */
export function mount(prefix: string, handler: Handler, guard?: Guard): Route[] {
  return [prefix, `${prefix}/*`].flatMap(pattern =>
    METHODS.map(method => route(method, pattern, handler, guard)),
  );
}

export function match(pattern: string, pathname: string): Params | undefined {
  const [parts, path] = [pattern.split('/'), pathname.split('/')];
  const rest = parts.at(-1) === '*';
  if (rest ? path.length < parts.length : path.length !== parts.length) return undefined;
  const params: Params = {};
  for (let i = 0; i < parts.length; i++) {
    const [part, value] = [parts[i]!, path[i]!];
    if (part === '*' && rest) {
      params['*'] = path.slice(i).join('/');
      break;
    }
    if (part[0] === ':') {
      if (!value) return undefined;
      params[part.slice(1)] = value;
    } else if (part !== value) return undefined;
  }

  return params;
}

export async function dispatch(
  routes: readonly Route[],
  req: Request,
  ctx: ServerContext,
  url: URL,
) {
  for (const first of routes) {
    const params = match(first.pattern, url.pathname);
    if (!params) continue;
    for (const name of Object.keys(params))
      if (name !== '*') params[name] = decodeURIComponent(params[name]!);
    const matching = routes.filter(entry => entry.pattern === first.pattern);
    const selected = matching.find(entry => entry.method === req.method);
    const guard = (selected ?? first).guard;
    if (guard) {
      const checked = await guard(req, ctx, params, url);
      if (checked instanceof Response) return checked;
      ctx = checked;
    }
    if (selected) return selected.handler(req, ctx, params, url);
    const response = notAllowed();
    response.headers.set('allow', [...new Set(matching.map(entry => entry.method))].join(', '));
    return response;
  }

  return undefined;
}
