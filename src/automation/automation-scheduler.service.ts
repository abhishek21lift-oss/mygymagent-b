import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  JOB_NAMES,
  JOB_SCHEDULER_IDS,
  QUEUE_NAMES,
} from '../queue/queue.constants';

/** Fixed UTC hour the remaining daily scans run at. The WhatsApp rows
 * tick hourly instead: each gym's saved execution time is matched
 * against its own timezone at scan time (see automation-schedule.helper
 * and MemberMessenger.sendWindowOpen), which one global daily cron
 * cannot express. */
const DAILY_SCAN_HOUR_UTC = 8;
const HOURLY = 60 * 60 * 1000;

/**
 * The churn scores are rebuilt overnight rather than with the daytime
 * scans: 23:00 UTC is 04:30 in India, so an owner opening Member
 * Intelligence first thing sees this morning's picture. Until this ran on
 * a schedule, every score in production had come from someone clicking
 * "Recompute" -- one member of 955 had ever been scored.
 */
export const RISK_SCAN_PATTERN = '0 23 * * *';

/**
 * The "Scheduler" half of "Scheduler + Jobs infrastructure": registers
 * BullMQ's own repeatable-job primitive (`Queue.upsertJobScheduler`) for
 * each daily scan, rather than building a second scheduling abstraction
 * on top of BullMQ, which already gives every job here retries/backoff
 * (`QueueModule`'s `defaultJobOptions`), failure tracking (`removeOnFail`
 * + the Worker's `failed` event), and idempotent re-registration
 * (`upsertJobScheduler` is safe to call on every boot -- it updates the
 * existing schedule in place rather than creating a duplicate).
 */
@Injectable()
export class AutomationSchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AutomationSchedulerService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.AUTOMATION) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const pattern = `0 ${DAILY_SCAN_HOUR_UTC} * * *`;

    await Promise.all([
      this.queue.upsertJobScheduler(
        JOB_SCHEDULER_IDS.SCAN_MEMBERSHIP_RENEWALS,
        { every: HOURLY },
        { name: JOB_NAMES.SCAN_MEMBERSHIP_RENEWALS },
      ),
      this.queue.upsertJobScheduler(
        JOB_SCHEDULER_IDS.SCAN_MEMBERSHIP_EXPIRY_ON_DAY,
        { every: HOURLY },
        { name: JOB_NAMES.SCAN_MEMBERSHIP_EXPIRY_ON_DAY },
      ),
      this.queue.upsertJobScheduler(
        JOB_SCHEDULER_IDS.SCAN_MEMBERSHIP_POST_EXPIRY,
        { every: HOURLY },
        { name: JOB_NAMES.SCAN_MEMBERSHIP_POST_EXPIRY },
      ),
      this.queue.upsertJobScheduler(
        JOB_SCHEDULER_IDS.SCAN_BIRTHDAYS,
        { every: HOURLY },
        { name: JOB_NAMES.SCAN_BIRTHDAYS },
      ),
      this.queue.upsertJobScheduler(
        JOB_SCHEDULER_IDS.SCAN_PAYMENT_OVERDUE,
        { every: HOURLY },
        { name: JOB_NAMES.SCAN_PAYMENT_OVERDUE },
      ),
      this.queue.upsertJobScheduler(
        JOB_SCHEDULER_IDS.SCAN_MEMBER_INACTIVE,
        { every: HOURLY },
        { name: JOB_NAMES.SCAN_MEMBER_INACTIVE },
      ),
      this.queue.upsertJobScheduler(
        JOB_SCHEDULER_IDS.SCAN_LEAD_FOLLOWUPS_DUE,
        { pattern },
        { name: JOB_NAMES.SCAN_LEAD_FOLLOWUPS_DUE },
      ),
      this.queue.upsertJobScheduler(
        JOB_SCHEDULER_IDS.SCAN_DATA_RETENTION,
        { pattern },
        { name: JOB_NAMES.SCAN_DATA_RETENTION },
      ),
      this.queue.upsertJobScheduler(
        JOB_SCHEDULER_IDS.SCAN_INVOICE_DUNNING,
        { every: HOURLY },
        { name: JOB_NAMES.SCAN_INVOICE_DUNNING },
      ),
      this.queue.upsertJobScheduler(
        JOB_SCHEDULER_IDS.SCAN_PT_EXPIRY,
        { every: HOURLY },
        { name: JOB_NAMES.SCAN_PT_EXPIRY },
      ),
      // WS-3: first sub-hourly scan -- BullMQ's `every` (ms interval),
      // not a cron pattern, since 5-minute cadence has no cron-shape
      // equivalent in this scheduler's daily-pattern convention.
      this.queue.upsertJobScheduler(
        JOB_SCHEDULER_IDS.SCAN_LEAD_FIRST_TOUCH,
        { every: 5 * 60 * 1000 },
        { name: JOB_NAMES.SCAN_LEAD_FIRST_TOUCH },
      ),
      this.queue.upsertJobScheduler(
        JOB_SCHEDULER_IDS.SCAN_RISK_PROFILES,
        { pattern: RISK_SCAN_PATTERN },
        { name: JOB_NAMES.SCAN_RISK_PROFILES },
      ),
      this.queue.upsertJobScheduler(
        JOB_SCHEDULER_IDS.ROTATE_QR_TOKENS,
        { every: 7 * 24 * 60 * 60 * 1000 },
        { name: JOB_NAMES.ROTATE_QR_TOKENS },
      ),
      this.queue.upsertJobScheduler(
        JOB_SCHEDULER_IDS.SCAN_MEMBERSHIP_STATUS,
        { every: 60 * 60 * 1000 },
        { name: JOB_NAMES.SCAN_MEMBERSHIP_STATUS },
      ),
      // Daily Action Center. Hourly rather than once a day: each gym's
      // "today" starts at its own midnight, and every run is idempotent
      // (dedupe keys), so an hourly pass both catches each gym's new day
      // and closes tasks soon after a member pays or renews.
      this.queue.upsertJobScheduler(
        JOB_SCHEDULER_IDS.GENERATE_ACTION_TASKS,
        { every: 60 * 60 * 1000 },
        { name: JOB_NAMES.GENERATE_ACTION_TASKS },
      ),
      this.queue.upsertJobScheduler(
        JOB_SCHEDULER_IDS.TASK_REMINDERS,
        { every: 15 * 60 * 1000 },
        { name: JOB_NAMES.TASK_REMINDERS },
      ),
    ]);

    this.logger.log(
      `Registered hourly WhatsApp automation scans (renewals, on-day expiry, post-expiry, birthdays, overdue, inactive, dunning, PT expiry) + daily lead-followups/data-retention (${pattern} UTC) + nightly risk scoring (${RISK_SCAN_PATTERN} UTC) + lead first-touch every 5m + membership status hourly + QR rotation every 7d + Action Center tasks hourly and reminders every 15m`,
    );
  }
}
