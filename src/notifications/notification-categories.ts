/**
 * The categories a notification can be filed under -- and therefore the
 * only categories a user can hold a preference for.
 *
 * B-P0-11: `PATCH /notifications/preferences/:category` used to upsert
 * whatever string arrived in the path. `PATCH .../preferences/BILLING`
 * returned 200 and stored a row, the settings page could have shown it
 * saved, and it changed nothing -- the fan-out in
 * `NotificationsService.notifyOrganization` looks preferences up by the
 * exact category it is publishing under, and nothing publishes under
 * `BILLING`. A silently inert opt-out is worse than a rejection: the user
 * believes they have muted something they have not.
 *
 * This is the catalog both sides of that contract read. The listener's
 * handlers are typed against it, so a handler cannot publish under a
 * category the preferences screen has no row for; the controller
 * validates against it, so a preference cannot be stored for a category
 * nothing publishes under. Adding a category is one edit here plus the
 * handler that raises it.
 *
 * `label` and `description` travel with the key because the settings UI
 * needs them and it is the third place this list would otherwise be
 * written out by hand. `GET /notifications/categories` serves them.
 *
 * Not to be confused with the `MARKETING` / `TRANSACTIONAL` categories in
 * `CommunicationsService` -- those classify an outbound WhatsApp or email
 * send for consent purposes and have nothing to do with in-app
 * notification preferences.
 */
export const NOTIFICATION_CATEGORIES = [
  {
    key: 'MEMBERS',
    label: 'Members',
    description: 'New members and member activity.',
  },
  {
    key: 'MEMBERSHIPS',
    label: 'Memberships',
    description: 'Membership starts, cancellations and lifecycle events.',
  },
  {
    key: 'ATTENDANCE',
    label: 'Attendance',
    description: 'Member attendance activity.',
  },
  {
    key: 'PAYMENTS',
    label: 'Payments',
    description: 'Payments and refunds.',
  },
  {
    key: 'CRM',
    label: 'CRM',
    description: 'New leads and lead conversions.',
  },
  {
    key: 'WORKOUT',
    label: 'Workout',
    description: 'Workout assignments and sessions.',
  },
  {
    key: 'DIET',
    label: 'Diet',
    description: 'Diet plan assignments.',
  },
  {
    key: 'INVENTORY',
    label: 'Inventory',
    description: 'Low stock and inventory alerts.',
  },
  {
    key: 'PT',
    label: 'Personal training',
    description: 'PT bookings, completions and cancellations.',
  },
  {
    key: 'WHATSAPP',
    label: 'WhatsApp',
    description: 'Incoming WhatsApp messages.',
  },
] as const;

export type NotificationCategory =
  (typeof NOTIFICATION_CATEGORIES)[number]['key'];

export const NOTIFICATION_CATEGORY_KEYS: readonly NotificationCategory[] =
  NOTIFICATION_CATEGORIES.map((c) => c.key);

const KEY_SET = new Set<string>(NOTIFICATION_CATEGORY_KEYS);

export function isNotificationCategory(
  value: string,
): value is NotificationCategory {
  return KEY_SET.has(value);
}
