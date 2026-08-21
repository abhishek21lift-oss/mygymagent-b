import { Injectable, Logger } from '@nestjs/common';
import { CommunicationsService } from '../../communications/communications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationRunService } from '../automation-run.service';

const COOLDOWN_DAYS = 5;

/**
 * Trigger: an ACTIVE or PENDING membership whose `startDate` has passed
 * but whose net payments (payments minus refunds against them) fall short
 * of `membership.price`. There is no invoice/accounts-receivable model in
 * this schema -- this computes "outstanding balance" directly from
 * Membership.price and its real Payment/Refund rows rather than a
 * fabricated due-date system, so it's honest about what it actually knows:
 * a membership is short-paid, not "N days overdue against an invoice."
 * Conditions: not reminded for this membership in the last
 * `COOLDOWN_DAYS`. Action: `CommunicationsService.sendPaymentOverdueReminder`.
 */
@Injectable()
export class PaymentOverdueScanner {
  private readonly logger = new Logger(PaymentOverdueScanner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly runs: AutomationRunService,
  ) {}

  async scan(): Promise<{ checked: number; sent: number }> {
    const now = new Date();

    const memberships = await this.prisma.membership.findMany({
      where: { status: { in: ['ACTIVE', 'PENDING'] }, startDate: { lte: now } },
      include: {
        member: { select: { id: true, email: true, firstName: true } },
        payments: { include: { refunds: true } },
      },
    });

    let sent = 0;
    let checked = 0;
    for (const membership of memberships) {
      const grossPaid = membership.payments.reduce(
        (sum, p) => sum + Number(p.amount),
        0,
      );
      const refunded = membership.payments
        .flatMap((p) => p.refunds)
        .reduce((sum, r) => sum + Number(r.amount), 0);
      const outstanding = Number(membership.price) - (grossPaid - refunded);
      if (outstanding <= 0) continue;
      checked++;
      if (!membership.member.email) continue;

      const outcome = await this.runs.attempt(
        membership.organizationId,
        'PAYMENT_OVERDUE_REMINDER',
        membership.id,
        COOLDOWN_DAYS,
        () =>
          this.communications.sendPaymentOverdueReminder(
            membership.organizationId,
            membership.member.id,
            membership.member.email!,
            {
              firstName: membership.member.firstName,
              amount: outstanding.toFixed(2),
              currency: membership.currency,
            },
          ),
        { outstanding: outstanding.toFixed(2) },
      );
      if (outcome === 'SENT') sent++;
    }

    this.logger.log(
      `Payment overdue scan: ${checked} memberships with an outstanding balance, ${sent} reminders sent`,
    );
    return { checked, sent };
  }
}
