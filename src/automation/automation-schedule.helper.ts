import type { AutomationKey } from '@prisma/client';

const HH_MM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Control-center default execution times (gym-local HH:mm). Only the
 * WhatsApp rows have defaults; anything else runs whenever its schedule
 * ticks, exactly as before.
 */
export const DEFAULT_RUN_AT: Partial<Record<AutomationKey, string>> = {
  BIRTHDAY_WISH: '04:00',
  PAYMENT_OVERDUE_REMINDER: '05:00',
  INVOICE_DUE_REMINDER: '05:00',
  MEMBERSHIP_RENEWAL_REMINDER: '06:00',
  MEMBERSHIP_POST_EXPIRY: '07:00',
  MEMBERSHIP_EXPIRY_ON_DAY: '08:00',
  MEMBER_INACTIVE_RECOVERY: '08:00',
};

/** Fallback when neither the profile nor the organization names one. */
export const DEFAULT_AUTOMATION_TIMEZONE = 'Asia/Kolkata';

export function resolveAutomationTimezone(
  profileTimezone?: string | null,
  organizationTimezone?: string | null,
): string {
  return profileTimezone || organizationTimezone || DEFAULT_AUTOMATION_TIMEZONE;
}

function minutesOf(runAt: string): number | null {
  const match = HH_MM_RE.exec(runAt);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Whole minutes since local midnight for `now` in `timezone`. */
export function localMinutesNow(
  timezone: string,
  now: Date = new Date(),
): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: timezone,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

/**
 * Whether the hourly automation tick should process this key now: the
 * gym-local time falls in the hour starting at `runAt`. A null/blank
 * `runAt` means "no time gate" (keys without a control-center default
 * keep their old behavior). AutomationRun cooldowns still prevent a
 * second send if two ticks land in the same window.
 */
export function isDueAt(
  timezone: string,
  runAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!runAt) return true;
  const target = minutesOf(runAt);
  if (target === null) return true;
  const local = localMinutesNow(timezone, now);
  if (local === null) return true;
  const elapsed = (local - target + 24 * 60) % (24 * 60);
  return elapsed >= 0 && elapsed < 60;
}
