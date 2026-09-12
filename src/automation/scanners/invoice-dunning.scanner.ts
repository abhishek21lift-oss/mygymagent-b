import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CommunicationsService } from '../../communications/communications.service';
import { OVERDUE_GRACE_DAYS } from '../../invoices/invoices.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AutomationRunService } from '../automation-run.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Days relative to dueAt on which a nudge goes out: 3 days before, the
 * day itself, 3 days after, and 7 days after (which also flips OVERDUE). */
const DUNNING_WINDOWS = [-3, 0, 3, 7] as const;

function dueStateFor(window: number): string {
  if (window < 0) return `due in ${-window} days`;
  if (window === 0) return 'due today';
  return `${window} days overdue`;
}

/**
 * Trigger: an ISSUED/PART_PAID invoice whose dueAt lands exactly on one of
 * the DUNNING_WINDOWS relative to today (days computed from dueAt, not
 * from any fabricated schedule). Conditions: the member has an email, and
 * no INVOICE_DUE_REMINDER run for this invoice in the last day (a 1-day
 * cooldown is enough -- windows are 3+ days apart, so each window fires at
 * most once while same-day re-scans stay quiet). Action:
 * `CommunicationsService.sendInvoiceDueReminder` (EMAIL in v1 -- WHATSAPP
 * has no real provider yet) plus a DunningAttempt row recording the
 * channel actually used. T+7 additionally flips the invoice OVERDUE.
 */
@Injectable()
export class InvoiceDunningScanner {
  private readonly logger = new Logger(InvoiceDunningScanner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly runs: AutomationRunService,
  ) {}

  async scan(): Promise<{ checked: number; sent: number }> {
    const now = new Date();
    const invoices = await this.prisma.invoice.findMany({
      where: { status: { in: ['ISSUED', 'PART_PAID'] }, dueAt: { not: null } },
      include: {
        member: { select: { id: true, email: true, firstName: true } },
        paymentLinks: {
          select: {
            amount: true,
            payment: { select: { status: true } },
          },
        },
      },
    });

    let sent = 0;
    for (const invoice of invoices) {
      const daysPast = Math.floor(
        (now.getTime() - (invoice.dueAt as Date).getTime()) / MS_PER_DAY,
      );
      const window = (DUNNING_WINDOWS as readonly number[]).includes(daysPast)
        ? (daysPast as (typeof DUNNING_WINDOWS)[number])
        : null;
      const reachedGrace = daysPast >= OVERDUE_GRACE_DAYS;
      if (window === null && !reachedGrace) continue;
      if (!invoice.member.email) {
        // Still flip an emailed-less invoice that's past grace -- the
        // reminder can't go out, but the books shouldn't lie either.
        if (reachedGrace) await this.flipOverdue(invoice.id);
        continue;
      }

      if (window !== null) {
        const paid = invoice.paymentLinks.reduce(
          (sum, link) =>
            link.payment.status !== 'FAILED' ? sum.plus(link.amount) : sum,
          new Prisma.Decimal(0),
        );
        const outstanding = new Prisma.Decimal(invoice.grandTotal).minus(paid);
        if (outstanding.lte(0)) continue;
        const dueState = dueStateFor(window);
        const outcome = await this.runs.attempt(
          invoice.organizationId,
          'INVOICE_DUE_REMINDER',
          invoice.id,
          1,
          async () => {
            try {
              const log = await this.communications.sendInvoiceDueReminder(
                invoice.organizationId,
                invoice.member.id,
                invoice.member.email as string,
                {
                  firstName: invoice.member.firstName,
                  invoiceNumber: invoice.number,
                  amount: outstanding.toFixed(2),
                  currency: invoice.currency,
                  dueState,
                },
              );
              await this.prisma.dunningAttempt.create({
                data: {
                  invoiceId: invoice.id,
                  channel: 'EMAIL',
                  templateKey: 'invoice_due_reminder',
                  status: log.status,
                  sentAt: log.sentAt,
                },
              });
              return log;
            } catch (error) {
              await this.prisma.dunningAttempt.create({
                data: {
                  invoiceId: invoice.id,
                  channel: 'EMAIL',
                  templateKey: 'invoice_due_reminder',
                  status: 'FAILED',
                },
              });
              throw error;
            }
          },
          {
            window,
            dueState,
            outstanding: outstanding.toFixed(2),
            currency: invoice.currency,
          },
        );
        if (outcome === 'SENT') sent++;
      }

      if (reachedGrace) await this.flipOverdue(invoice.id);
    }

    this.logger.log(
      `Invoice dunning scan: ${invoices.length} open invoices with a due date, ${sent} reminders sent`,
    );
    return { checked: invoices.length, sent };
  }

  /** Conditional flip -- only moves ISSUED/PART_PAID, so a concurrent
   * capture that already settled the invoice wins the race harmlessly. */
  private async flipOverdue(invoiceId: string): Promise<void> {
    await this.prisma.invoice.updateMany({
      where: { id: invoiceId, status: { in: ['ISSUED', 'PART_PAID'] } },
      data: { status: 'OVERDUE' },
    });
  }
}
