/** Formats shared by server pages and islands; `tz` is the browser's zone from the `tz` cookie. */

export function zoneOf(request: Request): string {
  const match = (request.headers.get('cookie') ?? '').match(/(?:^|; )tz=([^;]+)/);
  const value = match ? decodeURIComponent(match[1]!) : '';
  try {
    if (value) new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value || 'UTC';
  } catch {
    return 'UTC';
  }
}

const parts = (value: number, tz: string, options: Intl.DateTimeFormatOptions) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { ...options, timeZone: tz })
      .formatToParts(value)
      .map(part => [part.type, part.value]),
  );

// Built from parts, so every ICU version, on the server or in the browser, prints the same text.
/** `short` prints only the time today and leaves out this year. */
export function formatDate(value: number | undefined, tz: string, short?: boolean) {
  if (!value) return 'Not available';
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  };
  const p = parts(value, tz, options);
  const time = `${p.hour}:${p.minute} ${p.dayPeriod}`;
  if (!short) return `${p.month} ${p.day}, ${p.year}, ${time}`;

  const now = parts(Date.now(), tz, options);
  if (p.year !== now.year) return `${p.month} ${p.day}, ${p.year}, ${time}`;

  return p.month === now.month && p.day === now.day ? time : `${p.month} ${p.day}, ${time}`;
}

/** The time of day as `formatDate` prints it, with seconds. */
export function formatTime(value: number, tz: string) {
  const p = parts(value, tz, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  return `${p.hour}:${p.minute}:${p.second} ${p.dayPeriod}`;
}

export function formatDay(value: number, tz: string) {
  const p = parts(value, tz, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `${p.month} ${p.day}, ${p.year}`;
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** Hours are the largest unit; past 10,000 h they read as 12.3K h. */
export function formatDuration(value?: number) {
  if (value === undefined) return 'Not available';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  const [unit, amount] = value < 3_600_000 ? ['min', value / 60_000] : ['h', value / 3_600_000];
  const text =
    amount >= 10_000
      ? compact.format(amount)
      : amount.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${text} ${unit}`;
}

export const formatCount = (value: number) => value.toLocaleString('en-US');

/** Large counts read as 5.4B or 12.3K; small ones stay exact. */
export const formatCompact = (value: number) =>
  value < 10_000 ? formatCount(value) : compact.format(value);

export function initial(name?: string) {
  return (name ?? '?').trim().charAt(0).toUpperCase() || '?';
}

export const reasonText = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);
