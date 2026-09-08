import { Injectable, Logger } from '@nestjs/common';
import { CommunicationsService } from '../../communications/communications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationRunService } from '../automation-run.service';

const LOOKAHEAD_HOURS = 24;
const COOLDOWN_DAYS = 1;

/**
 * Daily appointment reminder sweep: one TRANSACTIONAL email per BOOKED
 * appointment starting within the next 24h whose client has an email on
 * file (member email, lead email, or the clientEmail snapshot captured
 * at booking). Cooldown prevents re-sending for the same appointment
 * every day it stays inside the window; rescheduling resets remindersSent
 * but the cooldown still applies per (key, subjectId) pair.
 */
@Injectable()
export class AppointmentReminderScanner {
  private readonly logger = new Logger(AppointmentReminderScanner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly runs: AutomationRunService,
  ) {}

  async scan(): Promise<{ scanned: number; reminded: number }> {
    const now = new Date();
    const horizon = new Date(now.getTime() + LOOKAHEAD_HOURS * 60 * 60 * 1000);

    const upcoming = await this.prisma.appointment.findMany({
      where: {
        status: 'BOOKED',
        startTime: { gte: now, lte: horizon },
      },
      include: {
        member: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        staff: {
          select: { user: { select: { firstName: true, lastName: true } } },
        },
        branch: { select: { name: true } },
      },
    });

    let reminded = 0;
    for (const appointment of upcoming) {
      const email =
        appointment.clientEmail ?? appointment.member?.email ?? null;
      if (!email) continue;

      const firstName =
        appointment.member?.firstName ??
        appointment.clientName?.split(' ')[0] ??
        'there';

      const outcome = await this.runs.attempt(
        appointment.organizationId,
        'APPOINTMENT_REMINDER',
        appointment.id,
        COOLDOWN_DAYS,
        () =>
          this.communications.sendAppointmentReminder(
            appointment.organizationId,
            appointment.memberId,
            email,
            {
              firstName,
              title: appointment.title,
              appointmentTime: appointment.startTime.toISOString(),
              branchName: appointment.branch?.name ?? 'your branch',
              staffName: appointment.staff?.user
                ? `${appointment.staff.user.firstName} ${appointment.staff.user.lastName}`
                : 'our team',
            },
          ),
        { startTime: appointment.startTime.toISOString() },
      );
      if (outcome === 'SENT') {
        reminded++;
        await this.prisma.appointment.update({
          where: { id: appointment.id },
          data: { remindersSent: { increment: 1 } },
        });
      }
    }

    this.logger.log(
      `Appointment reminder scan: ${upcoming.length} upcoming, ${reminded} reminded`,
    );
    return { scanned: upcoming.length, reminded };
  }
}
