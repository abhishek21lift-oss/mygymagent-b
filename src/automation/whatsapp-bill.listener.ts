import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CommunicationsService } from '../communications/communications.service';
import {
  DomainEvent,
  type MembershipStartedEvent,
} from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationRunService } from './automation-run.service';
import { MemberMessenger } from './member-messenger.service';
import {
  readableDate,
  readableMoney,
  runningOrganization,
} from './automation-scope';
import { WhatsappProfileService } from './whatsapp-profile.service';

/**
 * Subscription-bill message for a freshly sold membership.
 *
 * Fires on `membership.started` -- the same event MembershipInvoiceListener
 * consumes -- and sends only after verifying the membership AND its
 * invoice both exist (a bill without an invoice number is worse than no
 * bill). When the invoice row has not landed yet (listener race), it
 * waits a few seconds and re-reads once; when there is still nothing,
 * it records a SKIPPED run and stops -- the dunning scanner backstops
 * unpaid invoices on its windows, so nothing stays silent forever.
 *
 * The gym's customized bill message (Control Center) replaces the
 * system template when set; both render the same bill variables.
 * Idempotency: one run per invoice, so renewals (new membership, new
 * invoice) each bill exactly once.
 */
@Injectable()
export class WhatsappBillListener {
  private readonly logger = new Logger(WhatsappBillListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly messenger: MemberMessenger,
    private readonly runs: AutomationRunService,
    private readonly profiles: WhatsappProfileService,
  ) {}

  @OnEvent(DomainEvent.MembershipStarted, { async: true })
  async handle(event: MembershipStartedEvent): Promise<void> {
    try {
      if (
        !(await this.messenger.automationEnabled(
          event.organizationId,
          'INVOICE_DUE_REMINDER',
        ))
      ) {
        return;
      }
      const membership = await this.prisma.membership.findFirst({
        where: {
          id: event.membershipId,
          organizationId: event.organizationId,
          member: { deletedAt: null },
          organization: runningOrganization,
        },
        select: {
          id: true,
          member: {
            select: { id: true, phone: true, firstName: true, deletedAt: true },
          },
          organization: { select: { timezone: true } },
        },
      });
      const member = membership?.member;
      if (!membership || !member?.phone || member.deletedAt) return;

      let invoice = await this.findInvoice(event);
      if (!invoice) {
        // MembershipInvoiceListener works the same event; give its insert
        // one chance to land before calling this a no-bill sale.
        await new Promise((resolve) => setTimeout(resolve, 3000));
        invoice = await this.findInvoice(event);
      }
      if (!invoice) {
        await this.prisma.automationRun.create({
          data: {
            organizationId: event.organizationId,
            key: 'INVOICE_DUE_REMINDER',
            subjectId: `bill:${event.membershipId}`,
            status: 'SKIPPED',
            detail: {
              reason: 'no-invoice-yet',
              membershipId: event.membershipId,
            },
          },
        });
        return;
      }

      const profile = await this.profiles.get(event.organizationId);
      const dueDate = readableDate(
        invoice.dueAt ?? invoice.createdAt,
        membership.organization.timezone,
      );
      const variables = {
        firstName: member.firstName,
        invoiceNumber: invoice.number,
        amount: readableMoney(Number(invoice.grandTotal), invoice.currency),
        currency: invoice.currency,
        dueState: 'issued',
        dueDate,
        salutation: profile.salutation,
      };
      await this.runs.attempt(
        event.organizationId,
        'INVOICE_DUE_REMINDER',
        `bill:${invoice.id}`,
        365,
        () =>
          profile.customBillMessage
            ? this.communications.sendAdHoc({
                organizationId: event.organizationId,
                channel: 'WHATSAPP',
                category: 'TRANSACTIONAL',
                templateKey: 'bill.custom',
                recipient: member.phone as string,
                memberId: member.id,
                body: profile.customBillMessage as string,
                variables,
              })
            : this.communications.send({
                organizationId: event.organizationId,
                channel: 'WHATSAPP',
                category: 'TRANSACTIONAL',
                templateKey: 'invoice.due_soon',
                recipient: member.phone as string,
                memberId: member.id,
                variables: {
                  '1': member.firstName,
                  '2': invoice.number,
                  '3': Number(invoice.grandTotal).toFixed(2),
                  '4': invoice.currency,
                  '5': dueDate,
                },
              }),
        { membershipId: event.membershipId, invoiceId: invoice.id },
      );
    } catch (error) {
      // The sale is recorded either way; a bill message must never undo it.
      this.logger.warn(
        `WhatsApp bill message for membership ${event.membershipId} failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  private findInvoice(event: MembershipStartedEvent) {
    return this.prisma.invoice.findFirst({
      where: {
        organizationId: event.organizationId,
        membershipId: event.membershipId,
        status: { in: ['ISSUED', 'PART_PAID'] },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        number: true,
        grandTotal: true,
        currency: true,
        dueAt: true,
        createdAt: true,
      },
    });
  }
}
