export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Sender display name, e.g. an org's branding (`Organization.emailFromName`)
   * falling back to the platform default. The address itself always comes
   * from `SMTP_FROM_ADDRESS` -- providers don't let arbitrary tenant input
   * become the envelope sender. */
  fromName?: string;
  replyTo?: string;
}

/** Thrown by a provider that isn't configured (or doesn't exist yet, e.g.
 * WhatsApp/SMS/push today) -- CommunicationsService catches this, records
 * the attempt as FAILED in MessageLog with this message, and rethrows so a
 * queued send still gets BullMQ's normal retry/failure handling. */
export class ChannelNotConfiguredError extends Error {}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}
