import type { PrismaService } from '../../prisma/prisma.service';

const MS_PER_MINUTE = 60 * 1000;

/** The gym's IANA timezone; Asia/Kolkata when unset or unknown. */
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

export async function organizationTimezone(
  prisma: PrismaService,
  organizationId: string,
): Promise<string> {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { timezone: true },
  });
  return validTimezone(organization?.timezone);
}

export function validTimezone(timezone: string | null | undefined): string {
  if (!timezone) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return timezone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** The calendar date `date` falls on in `timezone`. */
export function zonedDate(
  date: Date,
  timezone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: validTimezone(timezone),
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** Minutes `timezone` is ahead of UTC at `date` (+330 for India). */
function offsetMinutes(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: validTimezone(timezone),
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - date.getTime()) / MS_PER_MINUTE);
}

/**
 * The instant a local calendar day begins in `timezone`. Months and days
 * overflow the way Date.UTC's do, so (2026, 13, 1) is 1 Jan 2027.
 */
export function zonedMidnight(
  year: number,
  month: number,
  day: number,
  timezone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day);
  // Twice, so a day that starts on a DST change still lands on midnight.
  let instant =
    guess - offsetMinutes(new Date(guess), timezone) * MS_PER_MINUTE;
  instant = guess - offsetMinutes(new Date(instant), timezone) * MS_PER_MINUTE;
  return new Date(instant);
}

/**
 * When today began for the gym. "Today" in UTC starts at 05:30 in India,
 * so the dashboard's today figures showed yesterday until then.
 */
export function startOfZonedDay(date: Date, timezone: string): Date {
  const { year, month, day } = zonedDate(date, timezone);
  return zonedMidnight(year, month, day, timezone);
}

/** When the gym's calendar month began, `monthsBack` months ago. */
export function startOfZonedMonth(
  date: Date,
  timezone: string,
  monthsBack = 0,
): Date {
  const { year, month } = zonedDate(date, timezone);
  return zonedMidnight(year, month - monthsBack, 1, timezone);
}

/** "YYYY-MM" of the gym's calendar month containing `date`. */
export function zonedMonthKey(date: Date, timezone: string): string {
  const { year, month } = zonedDate(date, timezone);
  return `${year}-${String(month).padStart(2, '0')}`;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A filter bound from a query string. A bare date ("2026-10-01") means that
 * day in the gym's timezone: its start for `from`, and the start of the next
 * day for `to`, which the caller compares with `lt` so the whole day is in.
 * Anything with a time is taken as the instant it names.
 */
export function zonedBound(
  value: string,
  timezone: string,
  edge: 'from' | 'to',
): Date {
  if (DATE_ONLY.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return zonedMidnight(year, month, day + (edge === 'to' ? 1 : 0), timezone);
  }
  const instant = new Date(value);
  // An exact instant as `to` stays inclusive under the caller's `lt`.
  return edge === 'to' ? new Date(instant.getTime() + 1) : instant;
}
