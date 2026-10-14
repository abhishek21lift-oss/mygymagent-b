import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  DomainEvent,
  type PaymentRecordedEvent,
} from '../events/domain-events';
import { AutomationRunService } from './automation-run.service';
import { MemberMessenger } from './member-messenger.service';
import { CommunicationsService } from '../communications/communications.service';
import { PrismaService } from '../prisma/prisma.service';
import { readableMoney, runningOrganization } from './automation-scope';

/**
 * A WhatsApp receipt for a payment taken at the front desk, when the gym
 * sends from its own linked number.
 *
 * WhatsApp only: these payments never had an email receipt (only online
 * Razorpay payments do, from InvoicesService), and starting to email every
 * cash payment is a change a gym should ask for, not find.
 *
 * Gated by the gym's PAYMENT_RECEIPT switch and recorded as an
 * AutomationRun per payment: the same payment is announced twice when it
 * rides along with a membership sale (MembershipsService.announceStart
 * emits PaymentRecorded right after Billing does), and without the
 * idempotency key the member would get two receipts.
 */
@Injectable()
export class PaymentReceiptListener {
  private readonly logger = new Logger(PaymentReceiptListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
    private readonly messenger: MemberMessenger,
    private readonly runs: AutomationRunService,
  ) {}

  @OnEvent(DomainEvent.PaymentRecorded, { async: true })
  async handle(event: PaymentRecordedEvent): Promise<void> {
    try {
      // The receipt must never undo the payment: every check below
      // returns quietly, and only a verified COMPLETED payment sends.
      if (
        !(await this.messenger.automationEnabled(
          event.organizationId,
          'PAYMENT_RECEIPT',
        ))
      ) {
        return;
      }
      if (
        !(await this.communications.ownWhatsappNumberReady(
          event.organizationId,
        ))
      ) {
        return;
      }
      const payment = await this.prisma.payment.findFirst({
        where: {
          id: event.paymentId,
          organizationId: event.organizationId,
          status: 'COMPLETED',
          organization: runningOrganization,
        },
        select: {
          amount: true,
          currency: true,
          member: {
            select: { id: true, phone: true, firstName: true, deletedAt: true },
          },
        },
      });
      const member = payment?.member;
      if (!payment || !member?.phone || member.deletedAt) return;
      await this.runs.attempt(
        event.organizationId,
        'PAYMENT_RECEIPT',
        event.paymentId,
        365,
        () =>
          this.communications.send({
            organizationId: event.organizationId,
            channel: 'WHATSAPP',
            category: 'TRANSACTIONAL',
            templateKey: 'payment.received',
            recipient: member.phone as string,
            memberId: member.id,
            variables: {
              firstName: member.firstName,
              amount: readableMoney(Number(payment.amount), payment.currency),
            },
          }),
        { paymentId: event.paymentId },
      );
    } catch (error) {
      // The payment is recorded either way; a receipt must never undo it.
      this.logger.warn(
        `WhatsApp receipt for payment ${event.paymentId} failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
}
