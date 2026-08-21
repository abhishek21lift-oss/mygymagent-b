/** System-default message templates, seeded with `organizationId: null` by
 * prisma/seed.ts (same idempotent-upsert pattern as
 * PERMISSIONS_CATALOG/ROLES_CATALOG). MessageTemplateService.resolve()
 * falls back to these when an organization hasn't created its own
 * override row for a given (key, channel) -- see that service's comment.
 *
 * `{{variable}}` placeholders are replaced by MessageTemplateService.render()
 * with plain string substitution (no HTML escaping, since these render to
 * plain-text email bodies today -- revisit if/when an HTML channel is
 * added). Every key referenced by CommunicationsService's callers must
 * have a row here so a real send never has *nothing* to fall back to. */
export interface DefaultTemplateDef {
  key: string;
  channel: 'EMAIL';
  subject: string;
  body: string;
}

export const DEFAULT_TEMPLATES_CATALOG: DefaultTemplateDef[] = [
  {
    key: 'welcome_email',
    channel: 'EMAIL',
    subject: 'Welcome to {{organizationName}}!',
    body: "Hi {{firstName}},\n\nWelcome to {{organizationName}} -- we're glad to have you. See you at the gym!",
  },
  {
    key: 'email_verification',
    channel: 'EMAIL',
    subject: 'Verify your email',
    body: 'Hi {{firstName}},\n\nYour email verification code is: {{token}}\n\nIf you did not request this, you can ignore this message.',
  },
  {
    key: 'password_reset',
    channel: 'EMAIL',
    subject: 'Reset your password',
    body: 'Hi,\n\nReset your password using the link below. This link expires in 1 hour.\n\n{{resetUrl}}\n\nIf you did not request this, you can ignore this message.',
  },
  {
    key: 'staff_invite',
    channel: 'EMAIL',
    subject: "You've been invited to {{organizationName}}",
    body: "Hi {{firstName}},\n\nYou've been invited to join {{organizationName}} on MyGymAgent. Set your password using the link below. This link expires in 7 days.\n\n{{resetUrl}}",
  },
  {
    key: 'membership_renewal_reminder',
    channel: 'EMAIL',
    subject: 'Your membership at {{organizationName}} is expiring soon',
    body: 'Hi {{firstName}},\n\nYour {{planName}} membership expires on {{expiryDate}}. Renew soon to keep your access uninterrupted.',
  },
  {
    key: 'payment_overdue_reminder',
    channel: 'EMAIL',
    subject: 'Payment reminder from {{organizationName}}',
    body: 'Hi {{firstName}},\n\nThis is a reminder that a payment of {{amount}} {{currency}} is outstanding. Please reach out to the front desk to settle it.',
  },
  {
    key: 'member_inactive_recovery',
    channel: 'EMAIL',
    subject: 'We miss you at {{organizationName}}',
    body: "Hi {{firstName}},\n\nWe haven't seen you at {{organizationName}} in {{daysInactive}} days. Come back in -- we'd love to see you!",
  },
  {
    key: 'lead_followup_reminder',
    channel: 'EMAIL',
    subject: 'Follow up due: {{leadName}}',
    body: 'A follow-up with {{leadName}} is due on {{dueDate}}.\n\nNote: {{note}}',
  },
  {
    key: 'low_stock_alert',
    channel: 'EMAIL',
    subject: 'Low stock alert: {{productName}}',
    body: 'Stock for {{productName}} (SKU {{sku}}) at {{organizationName}} has dropped to {{quantityOnHand}}, at or below the reorder level of {{reorderLevel}}.',
  },
];
