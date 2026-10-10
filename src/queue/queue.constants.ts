/**
 * Queue and job-name constants, collected here rather than as string
 * literals scattered across producers/processors -- a typo in a queue
 * name silently creates a second, never-consumed queue instead of erroring.
 */
export const QUEUE_NAMES = {
  NOTIFICATIONS: 'notifications',
  AUTOMATION: 'automation',
  /** Its own queue: see PushDispatchService for why push cannot share
   * `notifications`. */
  PUSH: 'push',
  /** One gym's WhatsApp sends, spaced for ban safety, delivered by the
   * instance holding the gym's socket (see `src/whatsapp-web/`). */
  WA_SEND: 'wa-send',
  /** Due staff-composed WhatsApp messages (see `src/whatsapp/`). */
  WA_SCHEDULED: 'wa-scheduled',
  /** Outgoing webhook POSTs to gym-registered URLs (see `src/whatsapp/`). */
  WA_WEBHOOKS: 'wa-webhooks',
} as const;

export const JOB_NAMES = {
  SEND_WELCOME_EMAIL: 'send-welcome-email',
  DELIVER_PUSH: 'deliver-push',
  SEND_WHATSAPP_WEB: 'send-whatsapp-web',
  SEND_SCHEDULED_WHATSAPP: 'send-scheduled-whatsapp',
  SEND_BROADCAST_ITEM: 'send-broadcast-item',
  DELIVER_WEBHOOK: 'deliver-webhook',
  SCAN_MEMBERSHIP_RENEWALS: 'scan-membership-renewals',
  SCAN_PAYMENT_OVERDUE: 'scan-payment-overdue',
  SCAN_MEMBER_INACTIVE: 'scan-member-inactive',
  SCAN_LEAD_FOLLOWUPS_DUE: 'scan-lead-followups-due',
  SEND_LOW_STOCK_ALERT: 'send-low-stock-alert',
  SCAN_DATA_RETENTION: 'scan-data-retention',
  SCAN_INVOICE_DUNNING: 'scan-invoice-dunning',
  SCAN_LEAD_FIRST_TOUCH: 'scan-lead-first-touch',
  ROTATE_QR_TOKENS: 'rotate-qr-tokens',
  SCAN_PT_EXPIRY: 'scan-pt-expiry',
  SCAN_RISK_PROFILES: 'scan-risk-profiles',
  SCAN_MEMBERSHIP_STATUS: 'scan-membership-status',
  /** Daily Action Center: one call note through the AI. */
  ANALYZE_CALL_NOTE: 'analyze-call-note',
  /** Daily Action Center: build every gym's worklist from CRM records. */
  GENERATE_ACTION_TASKS: 'generate-action-tasks',
  /** Daily Action Center: due-soon reminders and overdue escalations. */
  TASK_REMINDERS: 'task-reminders',
} as const;

/** BullMQ job-scheduler ids (`Queue.upsertJobScheduler`'s first arg) --
 * distinct from JOB_NAMES because a scheduler id must be stable and unique
 * per repeatable schedule, while a job name can be reused across many
 * individual job instances. One-to-one with the SCAN_* job names above
 * today, but kept separate since that won't always be true. */
export const JOB_SCHEDULER_IDS = {
  SCAN_MEMBERSHIP_RENEWALS: 'scan-membership-renewals-daily',
  SCAN_PAYMENT_OVERDUE: 'scan-payment-overdue-daily',
  SCAN_MEMBER_INACTIVE: 'scan-member-inactive-daily',
  SCAN_LEAD_FOLLOWUPS_DUE: 'scan-lead-followups-due-daily',
  SCAN_DATA_RETENTION: 'scan-data-retention-daily',
  SCAN_INVOICE_DUNNING: 'scan-invoice-dunning-daily',
  SCAN_LEAD_FIRST_TOUCH: 'scan-lead-first-touch-5min',
  ROTATE_QR_TOKENS: 'rotate-qr-tokens-weekly',
  SCAN_PT_EXPIRY: 'scan-pt-expiry-daily',
  SCAN_RISK_PROFILES: 'scan-risk-profiles-nightly',
  SCAN_MEMBERSHIP_STATUS: 'scan-membership-status-hourly',
  GENERATE_ACTION_TASKS: 'generate-action-tasks-hourly',
  TASK_REMINDERS: 'task-reminders-15min',
} as const;
