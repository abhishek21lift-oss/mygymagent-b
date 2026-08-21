/**
 * Queue and job-name constants, collected here rather than as string
 * literals scattered across producers/processors -- a typo in a queue
 * name silently creates a second, never-consumed queue instead of erroring.
 */
export const QUEUE_NAMES = {
  NOTIFICATIONS: 'notifications',
} as const;

export const JOB_NAMES = {
  SEND_WELCOME_EMAIL: 'send-welcome-email',
} as const;
