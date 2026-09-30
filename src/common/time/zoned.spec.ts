import {
  startOfZonedDay,
  startOfZonedMonth,
  validTimezone,
  zonedBound,
  zonedMidnight,
  zonedMonthKey,
} from './zoned';

const IST = 'Asia/Kolkata';

describe('zoned time', () => {
  it("starts India's day at 18:30 UTC the evening before", () => {
    // 02:00 IST on 1 Oct is still 30 Sep in UTC.
    const now = new Date('2026-09-30T20:30:00Z');
    expect(startOfZonedDay(now, IST).toISOString()).toBe(
      '2026-09-30T18:30:00.000Z',
    );
  });

  it("starts India's month on the 1st at 00:00 IST", () => {
    const now = new Date('2026-09-30T20:30:00Z'); // 1 Oct, 02:00 IST
    expect(startOfZonedMonth(now, IST).toISOString()).toBe(
      '2026-09-30T18:30:00.000Z',
    );
    expect(startOfZonedMonth(now, IST, 1).toISOString()).toBe(
      '2026-08-31T18:30:00.000Z',
    );
    expect(zonedMonthKey(now, IST)).toBe('2026-10');
  });

  it('rolls months over the year', () => {
    expect(zonedMidnight(2026, 13, 1, IST).toISOString()).toBe(
      '2026-12-31T18:30:00.000Z',
    );
  });

  it('lands on midnight across a daylight-saving change', () => {
    // London moves to BST on 29 Mar 2026; the 30th begins at 23:00 UTC.
    expect(zonedMidnight(2026, 3, 30, 'Europe/London').toISOString()).toBe(
      '2026-03-29T23:00:00.000Z',
    );
  });

  it('reads a bare date as that whole local day', () => {
    expect(zonedBound('2026-10-01', IST, 'from').toISOString()).toBe(
      '2026-09-30T18:30:00.000Z',
    );
    expect(zonedBound('2026-10-01', IST, 'to').toISOString()).toBe(
      '2026-10-01T18:30:00.000Z',
    );
    expect(zonedBound('2026-10-01T10:00:00Z', IST, 'from').toISOString()).toBe(
      '2026-10-01T10:00:00.000Z',
    );
  });

  it('falls back to India for an unknown timezone', () => {
    expect(validTimezone('Mars/Olympus')).toBe(IST);
    expect(validTimezone(null)).toBe(IST);
  });
});
