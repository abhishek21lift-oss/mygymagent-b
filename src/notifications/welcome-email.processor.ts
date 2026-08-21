import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { MailerService } from '../common/mailer/mailer.service';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';

interface SendWelcomeEmailJobData {
  memberId: string;
  email: string;
  firstName?: string;
}

@Processor(QUEUE_NAMES.NOTIFICATIONS)
export class WelcomeEmailProcessor extends WorkerHost {
  private readonly logger = new Logger(WelcomeEmailProcessor.name);

  constructor(private readonly mailer: MailerService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== JOB_NAMES.SEND_WELCOME_EMAIL) return;
    const { email, firstName, memberId } = job.data as SendWelcomeEmailJobData;
    await this.mailer.sendWelcomeEmail(email, firstName ?? '');
    this.logger.log(`Sent welcome email for member ${memberId}`);
  }
}
