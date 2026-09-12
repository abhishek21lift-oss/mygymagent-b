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
  channel: 'EMAIL' | 'WHATSAPP';
  /** EMAIL-only -- WHATSAPP templates have no subject. */
  subject?: string;
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
  {
    key: 'payment.receipt',
    channel: 'EMAIL',
    subject: 'Payment receipt from {{organizationName}}',
    body: 'Hi {{firstName}},\n\nThank you -- we received your payment of {{amount}} {{currency}} against invoice {{invoiceNumber}}. Your receipt reference is {{paymentId}}.',
  },
  {
    key: 'invoice_due_reminder',
    channel: 'EMAIL',
    subject: 'Invoice {{invoiceNumber}} from {{organizationName}}',
    body: 'Hi {{firstName}},\n\nInvoice {{invoiceNumber}} for {{amount}} {{currency}} is {{dueState}}. Please reach out to the front desk to settle it.',
  },
  // -- WHATSAPP system defaults (v1, English only) -----------------------
  // Bodies use Meta-style positional `{{1}}` variables (left as-is by
  // MessageTemplateService.render() unless a matching variable is passed,
  // so they also survive as literal template parameter slots). Keys mirror
  // the automation/dunning moments that send on this channel.
  {
    key: 'welcome',
    channel: 'WHATSAPP',
    body: 'Hello {{1}}, welcome to {{2}}! Reply to this chat for help with classes, schedules, and memberships.',
  },
  {
    key: 'payment.receipt',
    channel: 'WHATSAPP',
    body: 'Hi {{1}}, we received your payment of {{2}} {{3}} against invoice {{4}}. Receipt ref: {{5}}. Thank you!',
  },
  {
    key: 'invoice.due_soon',
    channel: 'WHATSAPP',
    body: 'Hi {{1}}, invoice {{2}} for {{3}} {{4}} is due on {{5}}. Please pay before the due date to avoid any interruption.',
  },
  {
    key: 'invoice.overdue',
    channel: 'WHATSAPP',
    body: 'Hi {{1}}, invoice {{2}} for {{3}} {{4}} is now overdue. Please clear it at the front desk or reply here for help.',
  },
  {
    key: 'invoice.final_notice',
    channel: 'WHATSAPP',
    body: 'Hi {{1}}, final notice: invoice {{2}} for {{3}} {{4}} is still unpaid. Please pay immediately to keep your access active.',
  },
  {
    key: 'renewal.t7',
    channel: 'WHATSAPP',
    body: 'Hi {{1}}, your {{2}} membership expires on {{3}} (7 days left). Renew now to keep training without a break.',
  },
  {
    key: 'renewal.t3',
    channel: 'WHATSAPP',
    body: 'Hi {{1}}, your {{2}} membership expires in 3 days ({{3}}). Renew today to avoid losing access.',
  },
  {
    key: 'renewal.t0',
    channel: 'WHATSAPP',
    body: 'Hi {{1}}, your {{2}} membership expires today ({{3}}). Renew now to continue without interruption.',
  },
  {
    key: 'lead.first_touch',
    channel: 'WHATSAPP',
    body: 'Hi {{1}}, thanks for your interest in {{2}}! Want a free trial session? Reply YES and we will set it up.',
  },
  {
    key: 'lead.followup',
    channel: 'WHATSAPP',
    body: 'Hi {{1}}, just following up from {{2}}. Still thinking about joining? Reply to this message and we will help.',
  },
  {
    key: 'inactive.winback',
    channel: 'WHATSAPP',
    body: 'Hi {{1}}, we miss you at {{2}}! It has been {{3}} days since your last visit. Drop in this week -- your first session back is on us.',
  },
  {
    key: 'birthday',
    channel: 'WHATSAPP',
    body: 'Happy birthday, {{1}}! The team at {{2}} wishes you a strong year ahead. Show this message at the front desk for a birthday treat this week.',
  },
];
