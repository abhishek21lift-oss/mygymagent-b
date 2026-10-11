import { Prisma } from '@prisma/client';
import { quotePlanPrice } from './plan-pricing';

const dec = (v: unknown) => new Prisma.Decimal(v as number).toFixed(2);

describe('quotePlanPrice', () => {
  it('totals a plain price with no tax or fee', () => {
    const q = quotePlanPrice({ price: 2000 });
    expect(dec(q.totalPayable)).toBe('2000.00');
    expect(dec(q.tax)).toBe('0.00');
    expect(dec(q.discount)).toBe('0.00');
  });

  it('shows the was-price markdown without charging it', () => {
    const q = quotePlanPrice({ price: 2000, compareAtPrice: 2500 });
    expect(dec(q.discount)).toBe('500.00');
    expect(dec(q.totalPayable)).toBe('2000.00');
  });

  it('rejects an offer at or below the list price', () => {
    expect(() => quotePlanPrice({ price: 2000, compareAtPrice: 2000 })).toThrow(
      'compareAtPrice must exceed price',
    );
    expect(() => quotePlanPrice({ price: 2000, compareAtPrice: 1500 })).toThrow(
      'compareAtPrice must exceed price',
    );
  });

  it('adds exclusive GST on price plus joining fee', () => {
    const q = quotePlanPrice({
      price: 2000,
      joiningFee: 500,
      taxMode: 'exclusive',
      taxRate: 18,
    });
    // (2000 + 500) * 18% = 450
    expect(dec(q.taxable)).toBe('2500.00');
    expect(dec(q.tax)).toBe('450.00');
    expect(dec(q.totalPayable)).toBe('2950.00');
  });

  it('backs inclusive GST out of the total instead of adding it', () => {
    const q = quotePlanPrice({
      price: 2360,
      taxMode: 'inclusive',
      taxRate: 18,
    });
    expect(dec(q.totalPayable)).toBe('2360.00');
    // 2360 - 2360/1.18 = 360
    expect(dec(q.tax)).toBe('360.00');
  });

  it('rounds half-up once on the tax component', () => {
    const q = quotePlanPrice({
      price: 999,
      taxMode: 'exclusive',
      taxRate: 18,
    });
    // 999 * 18% = 179.82
    expect(dec(q.tax)).toBe('179.82');
    expect(dec(q.totalPayable)).toBe('1178.82');
  });

  it('rejects a tax rate without a mode and out-of-range rates', () => {
    expect(() => quotePlanPrice({ price: 100, taxRate: 18 })).toThrow(
      'taxRate requires a tax mode',
    );
    expect(() =>
      quotePlanPrice({ price: 100, taxMode: 'exclusive', taxRate: 30 }),
    ).toThrow('taxRate must be between 0 and 28');
  });

  it('rejects non-finite and negative inputs', () => {
    expect(() => quotePlanPrice({ price: NaN })).toThrow();
    expect(() => quotePlanPrice({ price: -5 })).toThrow();
    expect(() => quotePlanPrice({ price: 100, joiningFee: -1 })).toThrow();
  });
});
