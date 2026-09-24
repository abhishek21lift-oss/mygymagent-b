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
 * `memberFacing` marks the six a gym *member* can actually receive. The
 * member portal showed all ten, so a member was offered switches for
 * "low stock and inventory alerts" and "new leads" -- settings for
 * messages that will never be sent to them. `memberDescription` restates
 * those six from the member's side: the staff wording ("Member
 * attendance activity") describes other people.
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
    memberFacing: false,
  },
  {
    key: 'MEMBERSHIPS',
    label: 'Memberships',
    description: 'Membership starts, cancellations and lifecycle events.',
    memberDescription: 'Your membership starting, renewing or expiring.',
    memberFacing: true,
  },
  {
    key: 'ATTENDANCE',
    label: 'Attendance',
    description: 'Member attendance activity.',
    memberDescription: 'Your check-ins at the gym.',
    memberFacing: true,
  },
  {
    key: 'PAYMENTS',
    label: 'Payments',
    description: 'Payments and refunds.',
    memberDescription: 'Your payments, receipts and refunds.',
    memberFacing: true,
  },
  {
    key: 'CRM',
    label: 'CRM',
    description: 'New leads and lead conversions.',
    memberFacing: false,
  },
  {
    key: 'WORKOUT',
    label: 'Workout',
    description: 'Workout assignments and sessions.',
    memberDescription: 'New workout plans and sessions assigned to you.',
    memberFacing: true,
  },
  {
    key: 'DIET',
    label: 'Diet',
    description: 'Diet plan assignments.',
    memberDescription: 'New diet plans assigned to you.',
    memberFacing: true,
  },
  {
    key: 'INVENTORY',
    label: 'Inventory',
    description: 'Low stock and inventory alerts.',
    memberFacing: false,
  },
  {
    key: 'PT',
    label: 'Personal training',
    description: 'PT bookings, completions and cancellations.',
    memberDescription: 'Your personal-training bookings and changes.',
    memberFacing: true,
  },
  {
    key: 'WHATSAPP',
    label: 'WhatsApp',
    description: 'Incoming WhatsApp messages.',
    memberFacing: false,
  },
] as const;

export type NotificationCategory =
  (typeof NOTIFICATION_CATEGORIES)[number]['key'];

export const NOTIFICATION_CATEGORY_KEYS: readonly NotificationCategory[] =
  NOTIFICATION_CATEGORIES.map((c) => c.key);

const KEY_SET = new Set<string>(NOTIFICATION_CATEGORY_KEYS);

/** The categories a member can hold a meaningful preference for, with
 * the member-facing wording. The portal reads this; staff screens read
 * the full list. */
export const MEMBER_NOTIFICATION_CATEGORIES = NOTIFICATION_CATEGORIES.filter(
  (category) => category.memberFacing,
).map((category) => ({
  key: category.key,
  label: category.label,
  description: category.memberDescription,
}));

export const MEMBER_NOTIFICATION_CATEGORY_KEYS: readonly string[] =
  MEMBER_NOTIFICATION_CATEGORIES.map((category) => category.key);

export function isNotificationCategory(
  value: string,
): value is NotificationCategory {
  return KEY_SET.has(value);
}
