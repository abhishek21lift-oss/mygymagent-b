import { ChannelNotConfiguredError } from './email-provider.interface';

/** Shared shape for the non-email channels (WhatsApp, SMS, push) -- simpler
 * than EmailMessage since none of them have a subject/reply-to concept.
 * Real per-channel providers (e.g. a future WhatsApp Business API adapter)
 * implement this against their own SDK; nothing else in the codebase
 * should need to change when one lands, since CommunicationsService only
 * depends on this interface. */
export interface MessageProvider {
  send(message: { to: string; text: string }): Promise<void>;
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

  // eslint-disable-next-line @typescript-eslint/require-await -- always throws; no real send to await.
  async send(): Promise<void> {
    throw new ChannelNotConfiguredError(
      `${this.channelName} is not connected on this deployment -- no provider is implemented yet.`,
    );
  }
}
