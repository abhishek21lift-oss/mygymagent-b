import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';
import {
  ScheduledMessageService,
  type ScheduledSendJob,
} from './scheduled-message.service';

/** Fires due scheduled WhatsApp messages, exactly as composed. */
@Processor(QUEUE_NAMES.WA_SCHEDULED)
export class ScheduledMessageProcessor extends WorkerHost {
  private readonly logger = new Logger(ScheduledMessageProcessor.name);

  constructor(private readonly scheduled: ScheduledMessageService) {
    super();
  }

  async process(job: Job<ScheduledSendJob>): Promise<void> {
    if (job.name !== JOB_NAMES.SEND_SCHEDULED_WHATSAPP) {
      throw new UnrecoverableError(`Unknown job "${job.name}"`);
    }
    await this.scheduled.fire(job.data.scheduledMessageId);
  }
}
