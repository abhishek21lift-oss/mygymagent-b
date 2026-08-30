/**
 * Queue and job-name constants, collected here rather than as string
 * literals scattered across producers/processors -- a typo in a queue
 * name silently creates a second, never-consumed queue instead of erroring.
 */
export const QUEUE_NAMES = {
  NOTIFICATIONS: 'notifications',
  AUTOMATION: 'automation',
} as const;

export const JOB_NAMES = {
  SEND_WELCOME_EMAIL: 'send-welcome-email',
  SCAN_MEMBERSHIP_RENEWALS: 'scan-membership-renewals',
  SCAN_PAYMENT_OVERDUE: 'scan-payment-overdue',
  SCAN_MEMBER_INACTIVE: 'scan-member-inactive',
  SCAN_LEAD_FOLLOWUPS_DUE: 'scan-lead-followups-due',
  SEND_LOW_STOCK_ALERT: 'send-low-stock-alert',
  SCAN_DATA_RETENTION: 'scan-data-retention',
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
} as const;
