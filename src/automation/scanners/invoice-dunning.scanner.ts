import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CommunicationsService } from '../../communications/communications.service';
import { OVERDUE_GRACE_DAYS } from '../../invoices/invoices.service';
import { PrismaService } from '../../prisma/prisma.service';
import { readableDate, runningOrganization } from '../automation-scope';
import { MemberMessenger } from '../member-messenger.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Days relative to dueAt on which a nudge goes out: 3 days before, the
 * day itself, 3 days after, and 7 days after (which also flips OVERDUE). */
const DUNNING_WINDOWS = [-3, 0, 3, 7] as const;

/** A scan that misses a window's day (a deploy at 08:00, an outage)
 * still sends it on one of the next few days, instead of never. */
const CATCH_UP_DAYS = 3;

/** The latest window at or before `daysPast`, if it is recent enough. */
export function dunningWindowFor(daysPast: number): number | null {
  const reached = DUNNING_WINDOWS.filter((w) => w <= daysPast);
  if (!reached.length) return null;
  const window = reached[reached.length - 1];
  return daysPast - window <= CATCH_UP_DAYS ? window : null;
}

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
    private readonly messenger: MemberMessenger,
  ) {}

  async scan(): Promise<{ checked: number; sent: number }> {
    const now = new Date();
    const invoices = await this.prisma.invoice.findMany({
      where: {
        // OVERDUE too: the last reminder falls on the day the invoice
        // turns overdue, and a scan that missed that day must still send it.
        status: { in: ['ISSUED', 'PART_PAID', 'OVERDUE'] },
        dueAt: { not: null },
        member: { deletedAt: null },
        organization: runningOrganization,
      },
      include: {
        member: {
          select: { id: true, email: true, phone: true, firstName: true },
        },
        organization: { select: { timezone: true } },
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
      const dueAt = invoice.dueAt as Date;
      const daysPast = Math.floor(
        (now.getTime() - dueAt.getTime()) / MS_PER_DAY,
      );
      const window = dunningWindowFor(daysPast);

      if (window !== null) {
        const paid = invoice.paymentLinks.reduce(
          (sum, link) =>
            link.payment.status !== 'FAILED' ? sum.plus(link.amount) : sum,
          new Prisma.Decimal(0),
        );
        const outstanding = new Prisma.Decimal(invoice.grandTotal).minus(paid);
        if (outstanding.gt(0)) {
          const dueState = dueStateFor(window);
          const whatsappTemplate =
            window <= 0
              ? 'invoice.due_soon'
              : window < OVERDUE_GRACE_DAYS
                ? 'invoice.overdue'
                : 'invoice.final_notice';
          const { outcome, channel } = await this.messenger.deliver({
            organizationId: invoice.organizationId,
            key: 'INVOICE_DUE_REMINDER',
            // One reminder per window, however many scans land in it.
            subjectId: `${invoice.id}:w${window}`,
            cooldownDays: 60,
            member: invoice.member,
            whatsapp: {
              templateKey: whatsappTemplate,
              variables: {
                '1': invoice.member.firstName,
                '2': invoice.number,
                '3': outstanding.toFixed(2),
                '4': invoice.currency,
                '5': readableDate(dueAt, invoice.organization.timezone),
              },
            },
            email: () =>
              this.communications.sendInvoiceDueReminder(
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
              ),
            detail: {
              window,
              dueState,
              outstanding: outstanding.toFixed(2),
              currency: invoice.currency,
            },
          });
          if (channel && (outcome === 'SENT' || outcome === 'FAILED')) {
            await this.prisma.dunningAttempt.create({
              data: {
                invoiceId: invoice.id,
                channel,
                templateKey:
                  channel === 'WHATSAPP'
                    ? whatsappTemplate
                    : 'invoice_due_reminder',
                // A WhatsApp message is queued, not yet delivered.
                status:
                  outcome === 'FAILED'
                    ? 'FAILED'
                    : channel === 'WHATSAPP'
                      ? 'PENDING'
                      : 'SENT',
                sentAt:
                  outcome === 'SENT' && channel === 'EMAIL' ? new Date() : null,
              },
            });
          }
          if (outcome === 'SENT') sent++;
        }
      }

      if (daysPast >= OVERDUE_GRACE_DAYS && invoice.status !== 'OVERDUE') {
        // With or without a reminder -- the books shouldn't lie.
        await this.flipOverdue(invoice.id);
      }
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
