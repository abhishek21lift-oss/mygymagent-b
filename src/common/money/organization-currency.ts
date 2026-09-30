import type { PrismaService } from '../../prisma/prisma.service';

/**
 * The currency a record takes when the caller names none: the
 * organization's, never the schema's `@default("USD")`. The app's forms
 * send no currency, so an INR gym's expenses, product sales and PT
 * packages were all written as USD -- the same bug the membership plans
 * had -- and the finance screens split one gym's money into two
 * currencies.
 */
export async function organizationCurrency(
  prisma: PrismaService,
  organizationId: string,
): Promise<string> {
  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { currency: true },
  });
  return organization.currency;
}
