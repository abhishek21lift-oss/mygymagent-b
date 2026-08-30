import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  JOB_NAMES,
  JOB_SCHEDULER_IDS,
  QUEUE_NAMES,
} from '../queue/queue.constants';

/** Fixed UTC hour every daily scan runs at. Same time for all five scans
 * today (they're independent and cheap enough to not need staggering at
 * current scale) -- a per-org schedule isn't something this data model
 * or the master prompt's P1 scope asks for. */
const DAILY_SCAN_HOUR_UTC = 8;

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
        { pattern },
        { name: JOB_NAMES.SCAN_MEMBERSHIP_RENEWALS },
      ),
      this.queue.upsertJobScheduler(
        JOB_SCHEDULER_IDS.SCAN_PAYMENT_OVERDUE,
        { pattern },
        { name: JOB_NAMES.SCAN_PAYMENT_OVERDUE },
      ),
      this.queue.upsertJobScheduler(
        JOB_SCHEDULER_IDS.SCAN_MEMBER_INACTIVE,
        { pattern },
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
    ]);

    this.logger.log(
      `Registered 5 daily automation scan schedulers (${pattern} UTC)`,
    );
  }
}
