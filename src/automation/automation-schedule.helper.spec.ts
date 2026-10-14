import {
  DEFAULT_AUTOMATION_TIMEZONE,
  DEFAULT_RUN_AT,
  isDueAt,
  resolveAutomationTimezone,
} from './automation-schedule.helper';

/** 04:00 in Kolkata is 22:30 UTC the previous day. */
const KOLKATA_4AM = new Date('2026-10-12T22:30:00.000Z');
const NEW_YORK_3AM = new Date('2026-10-12T07:30:00.000Z');

describe('DEFAULT_RUN_AT', () => {
  it('uses the control-center defaults for the six scheduled rows', () => {
    expect(DEFAULT_RUN_AT.BIRTHDAY_WISH).toBe('04:00');
    expect(DEFAULT_RUN_AT.PAYMENT_OVERDUE_REMINDER).toBe('05:00');
    expect(DEFAULT_RUN_AT.MEMBERSHIP_RENEWAL_REMINDER).toBe('06:00');
    expect(DEFAULT_RUN_AT.MEMBERSHIP_POST_EXPIRY).toBe('07:00');
    expect(DEFAULT_RUN_AT.MEMBERSHIP_EXPIRY_ON_DAY).toBe('08:00');
    expect(DEFAULT_RUN_AT.MEMBER_INACTIVE_RECOVERY).toBe('08:00');
  });
});

describe('isDueAt', () => {
  it('matches the gym-local hour for its saved time', () => {
    expect(isDueAt('Asia/Kolkata', '04:00', KOLKATA_4AM)).toBe(true);
    expect(isDueAt('Asia/Kolkata', '05:00', KOLKATA_4AM)).toBe(false);
  });

  it('is timezone-aware, not UTC-aware', () => {
    // 04:00 in Kolkata is 04:00 in New York at a different instant.
    expect(isDueAt('Asia/Kolkata', '04:00', NEW_YORK_3AM)).toBe(false);
    expect(isDueAt('America/New_York', '03:00', NEW_YORK_3AM)).toBe(true);
  });

  it('holds the whole hour, so an hourly tick never misses the window', () => {
    // Kolkata 04:00-04:59 is UTC 22:30-23:29.
    expect(
      isDueAt('Asia/Kolkata', '04:00', new Date('2026-10-12T22:30:00Z')),
    ).toBe(true);
    expect(
      isDueAt('Asia/Kolkata', '04:00', new Date('2026-10-12T23:05:00Z')),
    ).toBe(true);
    expect(
      isDueAt('Asia/Kolkata', '04:00', new Date('2026-10-12T23:29:00Z')),
    ).toBe(true);
    expect(
      isDueAt('Asia/Kolkata', '04:00', new Date('2026-10-12T22:29:00Z')),
    ).toBe(false);
    expect(
      isDueAt('Asia/Kolkata', '04:00', new Date('2026-10-12T23:30:00Z')),
    ).toBe(false);
  });

  it('degrades to due when there is no time or an unknown timezone', () => {
    expect(isDueAt('Asia/Kolkata', null, KOLKATA_4AM)).toBe(true);
    expect(isDueAt('Not/AZone', '04:00', KOLKATA_4AM)).toBe(true);
  });
});

describe('resolveAutomationTimezone', () => {
  it('prefers the profile, then the org, then the default', () => {
    expect(resolveAutomationTimezone('Europe/Berlin', 'Asia/Kolkata')).toBe(
      'Europe/Berlin',
    );
    expect(resolveAutomationTimezone(null, 'America/New_York')).toBe(
      'America/New_York',
    );
    expect(resolveAutomationTimezone(null, null)).toBe(
      DEFAULT_AUTOMATION_TIMEZONE,
    );
  });
});
