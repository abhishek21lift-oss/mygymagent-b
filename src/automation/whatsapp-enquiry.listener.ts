import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DomainEvent, type LeadCreatedEvent } from '../events/domain-events';
import { MemberMessenger } from './member-messenger.service';
import { LeadFirstTouchScanner } from './scanners/lead-first-touch.scanner';

/**
 * Immediate first touch for a newly created enquiry.
 *
 * Delegates to LeadFirstTouchScanner.scan() rather than duplicating its
 * assign-and-follow-up logic: the scan is idempotent per lead
 * (LEAD_FIRST_TOUCH + lead id, 365-day cooldown), so the event-driven
 * run and the every-5-minute backstop never double-send. Bulk imports
 * are excluded -- 500 imported rows must not become 500 WhatsApp
 * messages; those leads are worked through the normal follow-up queue.
 */
@Injectable()
export class WhatsappEnquiryListener {
  private readonly logger = new Logger(WhatsappEnquiryListener.name);

  constructor(
    private readonly messenger: MemberMessenger,
    private readonly scanner: LeadFirstTouchScanner,
  ) {}

  @OnEvent(DomainEvent.LeadCreated, { async: true })
  async handle(event: LeadCreatedEvent): Promise<void> {
    try {
      if (event.channel === 'IMPORT') return;
      if (
        !(await this.messenger.automationEnabled(
          event.organizationId,
          'LEAD_FIRST_TOUCH',
        ))
      ) {
        return;
      }
      await this.scanner.scan();
    } catch (error) {
      // Lead capture succeeded before this event; a greeting must never
      // fail it. The 5-minute scanner retries anything missed.
      this.logger.warn(
        `WhatsApp enquiry touch for lead ${event.leadId} failed: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
}
