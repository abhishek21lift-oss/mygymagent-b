import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DomainEvent,
  type WhatsappReceivedEvent,
} from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Files one inbound WhatsApp text: stores it, matches the sender to a
 * member, and emits `whatsapp.received` for the CRM queue and the
 * notification centre.
 *
 * Shared by every way a text can arrive -- today only the WA-AKG webhook
 * (WhatsappService) -- so a reply lands in the same place whichever
 * one carried it.
 */
@Injectable()
export class WhatsappInboundFiler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async file(organizationId: string, from: string, body: string) {
    const matchedMemberId = await this.matchMemberByPhone(organizationId, from);
    const row = await this.prisma.inboundMessage.create({
      data: { organizationId, from, body, matchedMemberId },
    });
    const event: WhatsappReceivedEvent = {
      organizationId,
      inboundMessageId: row.id,
      from,
      matchedMemberId,
    };
    this.events.emit(DomainEvent.WhatsappReceived, event);
    return row;
  }

  /**
   * Digits-suffix match: the inbound `from` is full international format
   * while a member's stored phone may be local (or vice versa), so either
   * side being a suffix of the other -- with at least 7 overlapping
   * digits -- counts as a match. Unknown numbers return null and are
   * still stored (the CRM unmatched queue reads exactly those rows).
   */
  async matchMemberByPhone(
    organizationId: string,
    from: string,
  ): Promise<string | null> {
    const fromDigits = from.replace(/\D/g, '');
    if (fromDigits.length < 7) return null;
    const members = await this.prisma.member.findMany({
      where: { organizationId, deletedAt: null },
      select: { id: true, phone: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const member of members) {
      if (!member.phone) continue;
      const memberDigits = member.phone.replace(/\D/g, '');
      if (memberDigits.length < 7) continue;
      if (
        fromDigits.endsWith(memberDigits) ||
        memberDigits.endsWith(fromDigits)
      ) {
        return member.id;
      }
    }
    return null;
  }
}
