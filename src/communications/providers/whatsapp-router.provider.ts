import { Injectable } from '@nestjs/common';
import { WhatsappWebSender } from '../../whatsapp-web/whatsapp-web.sender';
import type { MessageProvider } from '../interfaces/message-provider.interface';
import { MetaWhatsappProvider } from './meta-whatsapp.provider';

/**
 * The WHATSAPP channel: each gym's messages go out through the number it
 * chose. A gym that has linked its own number through WhatsApp Web and
 * turned on "send through it" uses that; every other gym uses the Meta
 * Cloud API, as before.
 *
 * A reply to a member's message (`fromOwnNumber`) always goes from the
 * linked number: the member wrote to that number, whatever the gym picked
 * for reminders.
 *
 * No silent fallback between the two: a gym that chose WhatsApp Web and
 * whose number has dropped gets a failure telling it to relink, not
 * messages quietly arriving from a different sender.
 */
@Injectable()
export class WhatsappRouterProvider implements MessageProvider {
  constructor(
    private readonly meta: MetaWhatsappProvider,
    private readonly web: WhatsappWebSender,
  ) {}

  async send(message: Parameters<MessageProvider['send']>[0]) {
    if (
      message.organizationId &&
      (message.fromOwnNumber ||
        (await this.web.isSelected(message.organizationId)))
    ) {
      return this.web.enqueue({
        ...message,
        organizationId: message.organizationId,
      });
    }
    return this.meta.send(message);
  }
}
