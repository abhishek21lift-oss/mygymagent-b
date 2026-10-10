import {
  DEFAULT_ACTION_CENTER_SETTINGS,
  inQuietHours,
  normaliseSettings,
} from './action-center.settings';

describe('Action Center settings', () => {
  it('falls back to defaults for missing or invalid values', () => {
    expect(normaliseSettings(undefined)).toEqual(
      DEFAULT_ACTION_CENTER_SETTINGS,
    );
    const s = normaliseSettings({
      inactiveDays: 1, // below the floor
      duesFollowUpIntervalDays: 'weekly',
      quietHoursStart: 25,
      renewalReminderDays: [3, 7, 7, -1, 100],
    });
    expect(s.inactiveDays).toBe(DEFAULT_ACTION_CENTER_SETTINGS.inactiveDays);
    expect(s.duesFollowUpIntervalDays).toBe(
      DEFAULT_ACTION_CENTER_SETTINGS.duesFollowUpIntervalDays,
    );
    expect(s.quietHoursStart).toBe(
      DEFAULT_ACTION_CENTER_SETTINGS.quietHoursStart,
    );
    // Deduplicated, in range, latest reminder first.
    expect(s.renewalReminderDays).toEqual([7, 3]);
  });

  it('allows switching quiet hours off', () => {
    const s = normaliseSettings({ quietHoursStart: null, quietHoursEnd: null });
    expect(inQuietHours(s, 23)).toBe(false);
  });

  it('handles a quiet window that wraps past midnight', () => {
    const s = normaliseSettings({ quietHoursStart: 22, quietHoursEnd: 7 });
    expect(inQuietHours(s, 23)).toBe(true);
    expect(inQuietHours(s, 3)).toBe(true);
    expect(inQuietHours(s, 7)).toBe(false);
    expect(inQuietHours(s, 12)).toBe(false);
    const day = normaliseSettings({ quietHoursStart: 13, quietHoursEnd: 15 });
    expect(inQuietHours(day, 14)).toBe(true);
    expect(inQuietHours(day, 16)).toBe(false);
  });
});
