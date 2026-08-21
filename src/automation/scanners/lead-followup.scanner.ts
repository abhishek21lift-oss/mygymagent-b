import { Injectable, Logger } from '@nestjs/common';
import { CommunicationsService } from '../../communications/communications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationRunService } from '../automation-run.service';

const COOLDOWN_DAYS = 1;

/**
 * Trigger: an incomplete `LeadFollowUp` whose `dueAt` has passed, on a
 * lead that has an assignee. Conditions: not reminded for this follow-up
 * in the last `COOLDOWN_DAYS` -- short (vs. the other scanners' 3-14
 * days) since a follow-up staying overdue is itself worth a daily nudge,
 * unlike a membership expiry date that doesn't change day to day. Action:
 * `CommunicationsService.sendLeadFollowupReminder`, sent to the assigned
 * staff member, not the lead -- no consent gate (internal staff
 * notification, not a message to a member).
 */
@Injectable()
export class LeadFollowupScanner {
  private readonly logger = new Logger(LeadFollowupScanner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly runs: AutomationRunService,
  ) {}

  async scan(): Promise<{ checked: number; sent: number }> {
    const now = new Date();

    const dueFollowUps = await this.prisma.leadFollowUp.findMany({
      where: {
        completedAt: null,
        dueAt: { lte: now },
        lead: { assignedToUserId: { not: null } },
      },
      include: {
        lead: {
          select: {
            firstName: true,
            lastName: true,
            assignedToUser: { select: { email: true } },
          },
        },
      },
    });

    let sent = 0;
    for (const followUp of dueFollowUps) {
      const assigneeEmail = followUp.lead.assignedToUser?.email;
      if (!assigneeEmail) continue;

      const outcome = await this.runs.attempt(
        followUp.organizationId,
        'LEAD_FOLLOWUP_REMINDER',
        followUp.id,
        COOLDOWN_DAYS,
        () =>
          this.communications.sendLeadFollowupReminder(
            followUp.organizationId,
            assigneeEmail,
            {
              leadName: `${followUp.lead.firstName} ${followUp.lead.lastName}`,
              dueDate: followUp.dueAt.toISOString().slice(0, 10),
              note: followUp.note,
            },
          ),
      );
      if (outcome === 'SENT') sent++;
    }

    this.logger.log(
      `Lead follow-up scan: ${dueFollowUps.length} overdue, ${sent} reminders sent`,
    );
    return { checked: dueFollowUps.length, sent };
  }
}
