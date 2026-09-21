import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelNotConfiguredError } from '../interfaces/email-provider.interface';
import type { MessageProvider } from '../interfaces/message-provider.interface';

@Injectable()
export class HttpChannelProvider implements MessageProvider {
  constructor(
    private readonly config: ConfigService,
    private readonly channel: 'SMS' | 'PUSH',
  ) {}
  async send(message: {
    to: string;
    text: string;
    organizationId?: string;
  }): Promise<string | void> {
    const prefix = this.channel === 'SMS' ? 'SMS' : 'PUSH';
    const url = this.config.get<string>(`${prefix}_PROVIDER_URL`, '');
    const token = this.config.get<string>(`${prefix}_PROVIDER_TOKEN`, '');
    if (!url || !token)
      throw new ChannelNotConfiguredError(
        `${this.channel} provider is not configured`,
      );
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: message.to,
        text: message.text,
        organizationId: message.organizationId,
      }),
    });
    if (!res.ok)
      throw new Error(`${this.channel} provider returned HTTP ${res.status}`);
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      messageId?: string;
    };
    return data.id ?? data.messageId;
  }
}
