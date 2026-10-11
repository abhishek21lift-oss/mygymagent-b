import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export type PlanTaxMode = 'none' | 'inclusive' | 'exclusive';

export interface PlanPriceInput {
  price: number | string | Prisma.Decimal;
  compareAtPrice?: number | string | Prisma.Decimal | null;
  joiningFee?: number | string | Prisma.Decimal | null;
  taxMode?: PlanTaxMode | null;
  taxRate?: number | string | Prisma.Decimal | null;
}

export interface PlanPriceQuote {
  listPrice: Prisma.Decimal;
  /** Was-price markdown shown to the customer. Zero when no offer. */
  discount: Prisma.Decimal;
  joiningFee: Prisma.Decimal;
  /** price + joiningFee: the amount tax applies to. */
  taxable: Prisma.Decimal;
  taxMode: PlanTaxMode;
  taxRate: Prisma.Decimal;
  tax: Prisma.Decimal;
  totalPayable: Prisma.Decimal;
}

const toDecimal = (v: number | string | Prisma.Decimal, field: string) => {
  const d = new Prisma.Decimal(v);
  if (!d.isFinite()) throw new BadRequestException(`${field} must be finite`);
  return d;
};

/**
 * The single authoritative plan-price formula. Taxable = list price +
 * joining fee (fee applies to the first sale only -- callers decide
 * when to include it). Half-up rounding happens once, on the tax
 * component; every other figure is already 2dp from validated input.
 * The sale path recomputes from stored plan values and never trusts
 * a client-calculated total.
 */
export function quotePlanPrice(input: PlanPriceInput): PlanPriceQuote {
  const listPrice = toDecimal(input.price, 'price');
  if (listPrice.isNegative())
    throw new BadRequestException('price must be non-negative');
  const joiningFee = toDecimal(input.joiningFee ?? 0, 'joiningFee');
  if (joiningFee.isNegative())
    throw new BadRequestException('joiningFee must be non-negative');
  const mode: PlanTaxMode = input.taxMode ?? 'none';
  if (mode !== 'none' && mode !== 'inclusive' && mode !== 'exclusive')
    throw new BadRequestException(
      'taxMode must be none, inclusive or exclusive',
    );
  const taxRate = toDecimal(input.taxRate ?? 0, 'taxRate');
  if (taxRate.isNegative() || taxRate.gt(28))
    throw new BadRequestException('taxRate must be between 0 and 28');
  if (mode === 'none' && !taxRate.isZero())
    throw new BadRequestException('taxRate requires a tax mode');

  let discount = new Prisma.Decimal(0);
  if (input.compareAtPrice !== undefined && input.compareAtPrice !== null) {
    const was = toDecimal(input.compareAtPrice, 'compareAtPrice');
    if (was.lte(listPrice))
      throw new BadRequestException('compareAtPrice must exceed price');
    discount = was.sub(listPrice);
  }

  const taxable = listPrice.add(joiningFee);
  let tax = new Prisma.Decimal(0);
  let totalPayable = taxable;
  if (mode === 'exclusive') {
    tax = taxable
      .mul(taxRate)
      .div(100)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    totalPayable = taxable.add(tax);
  } else if (mode === 'inclusive') {
    const divisor = new Prisma.Decimal(1).add(taxRate.div(100));
    tax = taxable
      .sub(taxable.div(divisor))
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    totalPayable = taxable;
  }
  return {
    listPrice,
    discount,
    joiningFee,
    taxable,
    taxMode: mode,
    taxRate,
    tax,
    totalPayable,
  };
}
