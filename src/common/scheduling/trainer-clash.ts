import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * A trainer's time is booked in two tables: PT sessions (`PtSession`,
 * keyed by the trainer's `StaffProfile`) and appointments
 * (`Appointment`, keyed by the trainer's `User`, with `PT_SESSION` as one
 * of its types). Each service used to check only its own table, so the
 * same trainer could hold a PT session and an appointment for the same
 * hour. This is the one check both use, across both tables.
 *
 * Statuses that hold the slot match each table's own rule: a scheduled or
 * completed PT session, a booked or rescheduled appointment.
 */
export async function assertTrainerFree(
  prisma: PrismaService,
  args: {
    organizationId: string;
    /** The trainer's user id (`Appointment.staffId`, `StaffProfile.userId`). */
    userId: string;
    start: Date;
    end: Date;
    /** The record being moved, so it does not clash with itself. */
    ignoreAppointmentId?: string;
    ignorePtSessionId?: string;
  },
): Promise<void> {
  const { organizationId, userId, start, end } = args;
  const [appointment, ptSession] = await Promise.all([
    prisma.appointment.findFirst({
      where: {
        organizationId,
        staffId: userId,
        status: { in: ['BOOKED', 'RESCHEDULED'] },
        ...(args.ignoreAppointmentId
          ? { id: { not: args.ignoreAppointmentId } }
          : {}),
        startTime: { lt: end },
        endTime: { gt: start },
      },
      select: { title: true },
    }),
    prisma.ptSession.findFirst({
      where: {
        organizationId,
        trainer: { userId },
        status: { in: ['SCHEDULED', 'COMPLETED'] },
        ...(args.ignorePtSessionId
          ? { id: { not: args.ignorePtSessionId } }
          : {}),
        startTime: { lt: end },
        endTime: { gt: start },
      },
      select: { member: { select: { firstName: true, lastName: true } } },
    }),
  ]);
  if (appointment)
    throw new BadRequestException(
      `Trainer is already booked at this time (${appointment.title})`,
    );
  if (ptSession) {
    const who =
      `${ptSession.member.firstName} ${ptSession.member.lastName}`.trim();
    throw new BadRequestException(
      `Trainer is already booked at this time (PT session${who ? ` with ${who}` : ''})`,
    );
  }
}

/** The user behind a `StaffProfile` id, for checks keyed by user. */
export async function trainerUserId(
  prisma: PrismaService,
  organizationId: string,
  staffProfileId: string,
): Promise<string | null> {
  const profile = await prisma.staffProfile.findFirst({
    where: { id: staffProfileId, organizationId },
    select: { userId: true },
  });
  return profile?.userId ?? null;
}
