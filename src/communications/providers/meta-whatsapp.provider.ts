import { Injectable } from '@nestjs/common';
import type { MessageProvider } from '../interfaces/message-provider.interface';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';

@Injectable()
export class MetaWhatsAppProvider implements MessageProvider {
  constructor(private readonly whatsapp: WhatsAppService) {}
  send(message: { organizationId: string; to: string; text: string }): Promise<void> {
    return this.whatsapp.sendText(message.organizationId, message.to, message.text).then(() => undefined);
  }
}
