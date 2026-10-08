/**
 * Outgoing-webhook event names. `test` is controller-only (never
 * emitted); the wildcard subscribes to all five emittable events.
 */
export const WEBHOOK_EVENTS = [
  'message.received',
  'message.sent',
  'message.failed',
  'broadcast.finished',
  'connection.update',
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number] | 'test';

/** Exact match or `'*'` subscription. */
export function matches(subscribed: string[], event: string): boolean {
  return subscribed.includes(event) || subscribed.includes('*');
}
