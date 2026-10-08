import type { PrismaService } from '../prisma/prisma.service';

/**
 * Settle-time counter step for P3 broadcasts (leaf module -- no service
 * imports, so processors and CommunicationsService can use it without a
 * module cycle). Call after incrementing one counter; flips SENDING to
 * DONE when every recipient settled. CANCELLED/DONE rows stay frozen.
 */
export async function noteBroadcastSettled(
  prisma: PrismaService,
  broadcastId: string,
  field: 'sent' | 'failed' | 'skipped',
): Promise<void> {
  await prisma.broadcast
    .update({ where: { id: broadcastId }, data: { [field]: { increment: 1 } } })
    .catch(() => undefined);
  const row = await prisma.broadcast
    .findUnique({
      where: { id: broadcastId },
      select: {
        status: true,
        total: true,
        sent: true,
        failed: true,
        skipped: true,
      },
    })
    .catch(() => null);
  if (
    row &&
    row.status !== 'DONE' &&
    row.status !== 'CANCELLED' &&
    row.sent + row.failed + row.skipped >= row.total
  ) {
    await prisma.broadcast
      .update({ where: { id: broadcastId }, data: { status: 'DONE' } })
      .catch(() => undefined);
  }
}
