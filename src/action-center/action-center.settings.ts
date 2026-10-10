import type { PrismaService } from '../prisma/prisma.service';

/**
 * The rules the daily generator and the reminders follow, per gym. Stored
 * under `Organization.settings.actionCenter`, so a gym changes them
 * without a migration; anything missing or out of range falls back to the
 * default here.
 */
export interface ActionCenterSettings {
  /** Days before a membership ends to put a renewal call on the list. */
  renewalReminderDays: number[];
  /** How far back an expired, unrenewed membership still gets a call. */
  expiredLookbackDays: number;
  /** How often an unpaid balance comes back as a task (days). */
  duesFollowUpIntervalDays: number;
  /** Days without a check-in before an active member is "inactive". */
  inactiveDays: number;
  /** Days after a promised date before the promise counts as missed. */
  promiseGraceDays: number;
  /** Hours a new enquiry may wait before "first contact" is due. */
  newLeadContactHours: number;
  /** Minutes before a task is due to remind the person it is assigned to. */
  reminderLeadMinutes: number;
  /** Hours a HIGH/URGENT task may sit overdue before managers hear of it. */
  overdueEscalationHours: number;
  /** Local hours (0-23) in which no reminder is sent; null for none. */
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  /** Cap on tasks a single source adds per run, so a backlog trickles in. */
  maxNewTasksPerSource: number;
}

export const DEFAULT_ACTION_CENTER_SETTINGS: ActionCenterSettings = {
  renewalReminderDays: [7, 3, 1, 0],
  expiredLookbackDays: 7,
  duesFollowUpIntervalDays: 7,
  inactiveDays: 14,
  promiseGraceDays: 1,
  newLeadContactHours: 2,
  reminderLeadMinutes: 30,
  overdueEscalationHours: 24,
  quietHoursStart: 22,
  quietHoursEnd: 7,
  maxNewTasksPerSource: 100,
};

function intIn(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : fallback;
}

function hourOrNull(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 23
    ? value
    : fallback;
}

/** A stored (or submitted) settings object, cleaned to valid values. */
export function normaliseSettings(raw: unknown): ActionCenterSettings {
  const d = DEFAULT_ACTION_CENTER_SETTINGS;
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const days = Array.isArray(s.renewalReminderDays)
    ? [
        ...new Set(
          s.renewalReminderDays.filter(
            (n): n is number => Number.isInteger(n) && n >= 0 && n <= 60,
          ),
        ),
      ].sort((a, b) => b - a)
    : d.renewalReminderDays;
  return {
    renewalReminderDays: days.length ? days.slice(0, 6) : d.renewalReminderDays,
    expiredLookbackDays: intIn(
      s.expiredLookbackDays,
      0,
      90,
      d.expiredLookbackDays,
    ),
    duesFollowUpIntervalDays: intIn(
      s.duesFollowUpIntervalDays,
      1,
      60,
      d.duesFollowUpIntervalDays,
    ),
    inactiveDays: intIn(s.inactiveDays, 3, 180, d.inactiveDays),
    promiseGraceDays: intIn(s.promiseGraceDays, 0, 14, d.promiseGraceDays),
    newLeadContactHours: intIn(
      s.newLeadContactHours,
      0,
      72,
      d.newLeadContactHours,
    ),
    reminderLeadMinutes: intIn(
      s.reminderLeadMinutes,
      0,
      24 * 60,
      d.reminderLeadMinutes,
    ),
    overdueEscalationHours: intIn(
      s.overdueEscalationHours,
      1,
      24 * 14,
      d.overdueEscalationHours,
    ),
    quietHoursStart: hourOrNull(s.quietHoursStart, d.quietHoursStart),
    quietHoursEnd: hourOrNull(s.quietHoursEnd, d.quietHoursEnd),
    maxNewTasksPerSource: intIn(
      s.maxNewTasksPerSource,
      1,
      1000,
      d.maxNewTasksPerSource,
    ),
  };
}

export async function loadSettings(
  prisma: PrismaService,
  organizationId: string,
): Promise<{ settings: ActionCenterSettings; timezone: string | null }> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { settings: true, timezone: true },
  });
  const stored = (org?.settings as Record<string, unknown> | null)
    ?.actionCenter;
  return {
    settings: normaliseSettings(stored),
    timezone: org?.timezone ?? null,
  };
}

/** Whether `hour` (local, 0-23) falls in the quiet window, which may wrap
 * past midnight (22 -> 7). */
export function inQuietHours(
  settings: ActionCenterSettings,
  hour: number,
): boolean {
  const { quietHoursStart: start, quietHoursEnd: end } = settings;
  if (start === null || end === null || start === end) return false;
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}
