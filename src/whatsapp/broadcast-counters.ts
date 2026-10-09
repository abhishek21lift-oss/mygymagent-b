import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { PrismaService } from '../prisma/prisma.service';
import { DomainEvent } from '../events/domain-events';

/**
 * Settle-time counter step for P3 broadcasts (leaf module -- no service
 * imports, so processors and CommunicationsService can use it without a
 * module cycle). Call after incrementing one counter; flips SENDING to
 * DONE when every recipient settled. CANCELLED/DONE rows stay frozen.
 * Returns true when this call flipped the row to DONE.
 */
export async function noteBroadcastSettled(
  prisma: PrismaService,
  broadcastId: string,
  field: 'sent' | 'failed' | 'skipped',
): Promise<boolean> {
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
    return true;
  }
  return false;
}

/**
 * Announces a flipped broadcast once (runs once per broadcast, not per
 * leg): shared by the wa-send and scheduled processors so the DONE
 * flip is announced whichever path settles the last leg.
 */
export async function announceBroadcastFinished(
  prisma: PrismaService,
  events: EventEmitter2,
  organizationId: string,
  broadcastId: string,
): Promise<void> {
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
  if (!row || row.status !== 'DONE') return;
  events.emit(DomainEvent.BroadcastFinished, {
    organizationId,
    broadcastId,
    status: 'DONE',
    total: row.total,
    sent: row.sent,
    failed: row.failed,
    skipped: row.skipped,
  });
}
