import type { ServerContext } from './context';
import {authorize} from './routes/guards';
import {json} from './routes/http';
import {runnerPrincipal} from './routes/guards';

export interface LimitsConfig {
  principalPerMinute?: number;
  ipPerMinute?: number;
  authPerMinute?: number;
  registerPerMinute?: number;
  pairingPerMinute?: number;
  concurrentTasks?: number;
}

/** Every server limit, per minute. Ordinary API traffic is generous; anything that mints or redeems a secret is tight. Config `limits` overrides any of them. */
export const SERVER_LIMITS = {
  // Requests per signed-in user, admin token or runner: a dashboard polling several lists stays well under this.
  principalPerMinute: 300,
  // Requests per IP without a principal, which is where every bad or missing token lands.
  ipPerMinute: 60,
  // Sign-in, token and login requests per IP: a person needs a handful, a brute force needs thousands.
  authPerMinute: 20,
  // Runner registrations per IP: each redeems a one-time pairing token, so guesses are what this stops.
  registerPerMinute: 10,
  // Pairing tokens minted per principal: one per machine being added.
  pairingPerMinute: 5,
  // Running tasks per workspace, or per local server.
  concurrentTasks: 10,
} as const;

/** Which bucket a request charges besides its principal or IP. */
export type LimitRoute = 'auth' | 'register' | 'pairing';

export class ServerLimits {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private sweptAt: number;
  readonly startedAt: number;
  requests = 0;
  rejections = 0;

  constructor(now = Date.now()) {
    this.startedAt = this.sweptAt = now;
  }

  consume(key: string, capacity: number, now: number): Response | undefined {
    if (now - this.sweptAt >= 60_000) {
      for (const [key, bucket] of this.buckets)
        if (now - bucket.at >= 60_000) this.buckets.delete(key);
      this.sweptAt = now;
    }
    const prior = this.buckets.get(key);
    const tokens = prior
      ? Math.min(capacity, prior.tokens + (Math.max(0, now - prior.at) * capacity) / 60_000)
      : capacity;
    const denied = tokens < 1;
    this.buckets.set(key, { tokens: denied ? tokens : tokens - 1, at: now });
    if (!denied) return;
    this.rejections++;
    const seconds = Math.max(1, Math.ceil(((1 - tokens) * 60) / capacity));
    return json({ error: `Too many requests. Try again in ${seconds} seconds.` }, 429, {
      'retry-after': String(seconds),
    });
  }
}

/** Which requests are limited, and which strict bucket they also charge; pages, assets and health are free. */
const LIMITED: Array<[matches: (path: string) => boolean, route?: LimitRoute]> = [
  [path => path === '/admin/runners/pair', 'pairing'],
  [path => path === '/runners/register', 'register'],
  [path => path.startsWith('/admin/') || path.startsWith('/runners/')],
  [path => path.startsWith('/api/auth') || path === '/login' || path === '/dash/token', 'auth'],
];

/** What the gate learned: the admin scope it already authorized, so the route does not look it up twice. */
export type Admitted = { scope?: ServerContext | Response };

/** Sits in front of every route: answers 429 itself, or admits the request with what it learned about the caller. */
export async function admit(
  req: Request,
  ctx: ServerContext,
  ip: string,
): Promise<Response | Admitted> {
  const path = new URL(req.url).pathname;
  const rule = LIMITED.find(([matches]) => matches(path));
  if (!rule) {
    // A signed-out dashboard request starts sign-in, so it charges the auth bucket as /login does.
    const signingIn =
      (path === '/dash' || path.startsWith('/dash/')) &&
      ctx.auth &&
      !(await ctx.auth.session(req.headers));
    return signingIn ? (rateLimit(ctx, undefined, ip, 'auth') ?? {}) : {};
  }

  const scope = path.startsWith('/admin/') ? await authorize(req, ctx) : undefined;
  const principal =
    path === '/runners/register'
      ? await runnerPrincipal(req, ctx)
      : scope && !(scope instanceof Response)
        ? scope.session
          ? `user:${scope.session.user.id}`
          : 'admin'
        : undefined;

  return rateLimit(ctx, principal, ip, rule[1]) ?? { scope };
}

export function rateLimit(
  ctx: ServerContext,
  principal: string | undefined,
  ip: string,
  route?: LimitRoute,
): Response | undefined {
  const limits = (ctx.limits ??= new ServerLimits((ctx.now ?? Date.now)()));
  const config = { ...SERVER_LIMITS, ...ctx.config.limits };
  const now = (ctx.now ?? Date.now)();
  const key = principal ?? `ip:${ip}`;

  const general = limits.consume(
    key,
    principal ? config.principalPerMinute : config.ipPerMinute,
    now,
  );
  if (general || !route) return general;

  // Secrets are minted per principal and redeemed per IP, so each strict bucket keys on the side an attacker controls.
  if (route === 'pairing') return limits.consume(`pair:${key}`, config.pairingPerMinute, now);
  return limits.consume(
    `${route}:ip:${ip}`,
    route === 'auth' ? config.authPerMinute : config.registerPerMinute,
    now,
  );
}
