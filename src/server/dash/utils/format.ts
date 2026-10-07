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
export function formatDate(value: number | undefined, tz: string) {
  if (!value) return 'Not available';
  const p = parts(value, tz, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${p.month} ${p.day}, ${p.year}, ${p.hour}:${p.minute} ${p.dayPeriod}`;
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

export function formatDuration(value?: number) {
  if (value === undefined) return 'Not available';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  const [unit, size] =
    value < 3_600_000
      ? (['min', 60_000] as const)
      : value < 172_800_000
        ? (['h', 3_600_000] as const)
        : (['d', 86_400_000] as const);
  return `${(value / size).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${unit}`;
}

export const formatCount = (value: number) => value.toLocaleString('en-US');

export function initial(name?: string) {
  return (name ?? '?').trim().charAt(0).toUpperCase() || '?';
}

export const reasonText = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);
