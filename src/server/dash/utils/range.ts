/** Usage ranges: presets back from now, or whole days from one date to another in the viewer's zone. */

const DAY = 86_400_000;
const timeKey = Symbol('coder.dashboard.time');

/** Repeated renders keep the same usage bounds and share their reads. */
export function rangeFor(request: Request, tz: string): Range {
  const render = request as Request & { [timeKey]?: number };
  const now = (render[timeKey] ??= Date.now());
  return rangeOf(new URL(request.url).searchParams, tz, now);
}

export const PRESETS: Record<string, { label: string; short: string; span: number }> = {
  '24h': { label: 'Last 24 hours', short: '24h', span: DAY },
  '7d': { label: 'Last 7 days', short: '7d', span: 7 * DAY },
  '30d': { label: 'Last 30 days', short: '30d', span: 30 * DAY },
  '90d': { label: 'Last 90 days', short: '90d', span: 90 * DAY },
};

export interface Range {
  key: string;
  label: string;
  since: number;
  until: number;
  /** The query that selects it, without a leading `?`. */
  query: string;
  from?: string;
  to?: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Milliseconds `tz` is ahead of UTC at `at`. */
function offset(at: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map(part => [part.type, Number(part.value)]),
  );
  return (
    Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) -
    Math.floor(at / 1000) * 1000
  );
}

/** Midnight at the start of `date` (YYYY-MM-DD) in `tz`. */
export function startOfDay(date: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!);
  return guess - offset(guess - offset(guess, tz), tz);
}

export function dayOf(at: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
}

const short = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

export function rangeOf(params: URLSearchParams, tz: string, now = Date.now()): Range {
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  if (DATE.test(from) && DATE.test(to) && from <= to) {
    const since = startOfDay(from, tz);
    return {
      key: 'custom',
      label: `${short(from)} to ${short(to)}`,
      since,
      until: Math.min(startOfDay(nextDay(to), tz), now),
      query: `from=${from}&to=${to}`,
      from,
      to,
    };
  }
  const key = params.get('range') ?? '';
  const chosen = Object.hasOwn(PRESETS, key) ? key : '7d';
  const preset = PRESETS[chosen]!;
  return {
    key: chosen,
    label: preset.label,
    since: now - preset.span,
    until: now,
    query: `range=${chosen}`,
  };
}

/** Every day the range touches, oldest first. */
export function daysIn(range: Range, tz: string): string[] {
  const days: string[] = [];
  const last = dayOf(range.until - 1, tz);
  for (let day = dayOf(range.since, tz); day <= last && days.length < 400; day = nextDay(day))
    days.push(day);
  return days;
}
