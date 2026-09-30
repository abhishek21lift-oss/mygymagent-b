import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CommunicationsService } from '../communications/communications.service';
import {
  DomainEvent,
  type PaymentRecordedEvent,
} from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import { readableMoney, runningOrganization } from './automation-scope';

/**
 * A WhatsApp receipt for a payment taken at the front desk, when the gym
 * sends from its own linked number.
 *
 * WhatsApp only: these payments never had an email receipt (only online
 * Razorpay payments do, from InvoicesService), and starting to email every
 * cash payment is a change a gym should ask for, not find.
 */
@Injectable()
export class PaymentReceiptListener {
  private readonly logger = new Logger(PaymentReceiptListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly communications: CommunicationsService,
  ) {}

  @OnEvent(DomainEvent.PaymentRecorded, { async: true })
  async handle(event: PaymentRecordedEvent): Promise<void> {
    try {
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
      await this.communications.send({
        organizationId: event.organizationId,
        channel: 'WHATSAPP',
        category: 'TRANSACTIONAL',
        templateKey: 'payment.received',
        recipient: member.phone,
        memberId: member.id,
        variables: {
          firstName: member.firstName,
          amount: readableMoney(Number(payment.amount), payment.currency),
        },
      });
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
