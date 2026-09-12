import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  DomainEvent,
  type WhatsappReceivedEvent,
} from '../events/domain-events';

/**
 * WS-3 minimal `whatsapp.received` consumer: unmatched inbound texts stay
 * visible via the existing GET /whatsapp/inbound queue (matched=false) and
 * are only logged here. Deliberately does NOT auto-create leads from chat
 * -- open-chat auto-creation is a spam vector (any wrong number or
 * broadcast reply would mint a lead).
 */
@Injectable()
export class WhatsappInboundListener {
  private readonly logger = new Logger(WhatsappInboundListener.name);

  @OnEvent(DomainEvent.WhatsappReceived)
  handleWhatsappReceived(event: WhatsappReceivedEvent): void {
    if (event.matchedMemberId) return;
    this.logger.log(
      `Unmatched WhatsApp inbound ${event.inboundMessageId} from ${event.from} (org ${event.organizationId}) -- visible at GET /whatsapp/inbound?matched=false, no lead auto-created`,
    );
  }
}
