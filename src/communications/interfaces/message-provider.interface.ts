import { ChannelNotConfiguredError } from './email-provider.interface';

/** Shared shape for the non-email channels (WhatsApp, SMS, push) -- simpler
 * than EmailMessage since none of them have a subject/reply-to concept.
 * Real per-channel providers (MetaWhatsappProvider today) implement this
 * against their own API; nothing else in the codebase should need to
 * change when one lands, since CommunicationsService only depends on this
 * interface.
 *
 * `organizationId` is the sending tenant, for providers whose credentials
 * are per-org (WhatsApp's vault) rather than deployment-wide (SMTP) --
 * CommunicationsService always passes it. The resolved provider-side
 * message id (Meta's `wamid`) is returned when the provider reports one so
 * CommunicationsService can store it on MessageLog for webhook status
 * callbacks; providers that report nothing resolve void. */
export interface MessageProvider {
  send(message: {
    to: string;
    text: string;
    organizationId?: string;
  }): Promise<string | void>;
}

/** The provider bound for WHATSAPP/SMS/PUSH until a real one is built --
 * always throws, never silently drops or fakes a send. Distinct from the
 * S3/OpenRouter "unconfigured" pattern (env vars present or absent) only
 * in that there is currently no configuration that would make this
 * channel real; see src/communications/README.md for what a real
 * implementation needs (provider SDK, credentials, a webhook receiver for
 * delivery status). */
export class UnimplementedChannelProvider implements MessageProvider {
  constructor(private readonly channelName: string) {}

  async send(): Promise<void> {
    throw new ChannelNotConfiguredError(
      `${this.channelName} is not connected on this deployment -- no provider is implemented yet.`,
    );
  }
}
