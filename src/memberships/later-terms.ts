import type { Prisma } from '@prisma/client';

type Db = Pick<Prisma.TransactionClient, 'membership'>;

/** A minute of slack: a renewal starts at the instant its predecessor
 * ends, but a term edited by hand may be off by seconds. */
const SEQUENTIAL_SLACK_MS = 60_000;

/**
 * Moves every term already sold after `membershipId` by `deltaMs`.
 *
 * A running membership renews into a new term that starts the day the
 * current one ends. When the current one then grows -- a freeze credited
 * back, a few days' extension -- the next term has to move with it.
 * Before, it stayed put: the two terms overlapped and the member lost
 * exactly the days they had been given.
 *
 * Follows the chain (a term renewed twice moves both later terms), and
 * only moves a term that starts where its predecessor ended: a plan
 * change's replacement starts mid-term and is not "later".
 */
export async function shiftLaterTerms(
  db: Db,
  membershipId: string,
  previousEnd: Date,
  deltaMs: number,
): Promise<number> {
  if (deltaMs === 0) return 0;
  let moved = 0;
  let currentId = membershipId;
  let currentEnd = previousEnd;
  const seen = new Set<string>([membershipId]);
  for (;;) {
    const next = await db.membership.findFirst({
      where: { previousMembershipId: currentId, status: { not: 'CANCELLED' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, startDate: true, endDate: true },
    });
    if (!next || seen.has(next.id)) break;
    if (next.startDate.getTime() < currentEnd.getTime() - SEQUENTIAL_SLACK_MS)
      break;
    seen.add(next.id);
    await db.membership.update({
      where: { id: next.id },
      data: {
        startDate: new Date(next.startDate.getTime() + deltaMs),
        endDate: new Date(next.endDate.getTime() + deltaMs),
      },
    });
    moved++;
    currentId = next.id;
    currentEnd = next.endDate;
  }
  return moved;
}
