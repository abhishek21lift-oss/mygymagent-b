import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  DomainEvent,
  type MembershipStartedEvent,
} from '../events/domain-events';
import { InvoicesService } from './invoices.service';

/**
 * Auto-raise consumer of `membership.started` (fired post-commit by
 * MembershipsService.create/renew): every sold membership gets an issued
 * invoice from plan price minus discount, with no staff action needed.
 *
 * Fire-and-forget by EventEmitter2's design -- nothing awaits this handler,
 * and InvoicesService.createFromMembership() itself swallows failures into
 * a warn log, so invoicing can never break the membership request no
 * matter what happens inside (a pricing bug must not fail a sale).
 */
@Injectable()
export class MembershipInvoiceListener {
  private readonly logger = new Logger(MembershipInvoiceListener.name);

  constructor(private readonly invoices: InvoicesService) {}

  @OnEvent(DomainEvent.MembershipStarted)
  async handleMembershipStarted(event: MembershipStartedEvent): Promise<void> {
    try {
      await this.invoices.createFromMembership(event);
    } catch (error) {
      this.logger.error(
        `Auto-invoice listener failed for membership ${event.membershipId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
}
