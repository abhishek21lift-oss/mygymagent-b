import { Prisma } from '@prisma/client';
import { inclusiveDays, monthlyShare } from './hr-payroll.service';

const d = (iso: string) => new Date(iso);
const salary = new Prisma.Decimal(31000);

describe('pay period maths', () => {
  it('pays a whole calendar month as one salary', () => {
    expect(
      monthlyShare(
        salary,
        d('2026-01-01T00:00:00Z'),
        d('2026-01-31T23:59:59.999Z'),
      ).toFixed(2),
    ).toBe('31000.00');
  });

  it('pays part of a month for the days covered', () => {
    // 15 of January's 31 days.
    expect(
      monthlyShare(
        salary,
        d('2026-01-01T00:00:00Z'),
        d('2026-01-15T23:59:59.999Z'),
      ).toFixed(2),
    ).toBe('15000.00');
  });

  it("splits a period across two months by each month's own length", () => {
    // 16-31 Jan (16/31) + 1-15 Feb 2026 (15/28).
    const share = monthlyShare(
      new Prisma.Decimal(28000),
      d('2026-01-16T00:00:00Z'),
      d('2026-02-15T23:59:59.999Z'),
    );
    expect(share.toFixed(2)).toBe(
      new Prisma.Decimal(28000)
        .mul(16)
        .div(31)
        .plus(new Prisma.Decimal(28000).mul(15).div(28))
        .toDecimalPlaces(2)
        .toFixed(2),
    );
  });

  it('counts calendar days with both ends included', () => {
    expect(inclusiveDays(d('2026-03-10'), d('2026-03-10'))).toBe(1);
    expect(inclusiveDays(d('2026-03-10'), d('2026-03-19'))).toBe(10);
    expect(
      inclusiveDays(d('2026-02-27T00:00:00Z'), d('2026-03-02T23:59:59Z')),
    ).toBe(4);
  });
});
