import type { MessageCategory } from '@prisma/client';
import { ChannelNotConfiguredError } from './email-provider.interface';

/** Shared shape for the non-email channels (WhatsApp, SMS, push) -- simpler
 * than EmailMessage since none of them have a subject/reply-to concept.
 * Real per-channel providers (WaAkgProvider today) implement this
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
/** A provider that sends later (WhatsApp Web's spaced queue) returns this
 * instead of a message id: the log row stays PENDING under
 * `providerMessageId` until the send settles it. */
export interface QueuedSend {
  queued: true;
  providerMessageId: string;
}

export interface MessageProvider {
  send(message: {
    to: string;
    text: string;
    organizationId?: string;
    /** For providers that treat categories differently -- WhatsApp Web
     * refuses MARKETING. */
    category?: MessageCategory;
    /** The MessageLog row this send is recorded on, for providers that
     * settle it later. */
    messageLogId?: string;
    /** WhatsApp only: send from the gym's own linked number whatever it
     * chose for reminders -- a reply to a chat must come from the number
     * the member wrote to. */
    fromOwnNumber?: boolean;
    /** WhatsApp only (P1): File id of an uploaded image to send with the
     * text. Validated org-scoped before enqueue, never a raw S3 key. */
    mediaKey?: string;
    /** WhatsApp only (P1): provider id to quote; unknown ids send
     * without a quote rather than failing. */
    replyToMessageId?: string;
    /** P3 broadcast this send fans out from, if any. */
    broadcastId?: string;
  }): Promise<string | void | QueuedSend>;
  /** Whether a send could succeed at all. Optional; absent means "assume
   * yes", which is the generic HTTP provider's honest answer. */
  isConfigured?(): boolean;
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
