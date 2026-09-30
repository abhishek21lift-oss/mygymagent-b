import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { CommunicationsService } from '../communications/communications.service';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';

interface SendWelcomeEmailJobData {
  organizationId: string;
  memberId: string;
  email?: string;
  phone?: string;
  firstName?: string;
}

/**
 * The new member's welcome: on WhatsApp when the gym sends from its own
 * linked number and the member has a phone, otherwise by email -- one or
 * the other, not both. A WhatsApp failure falls back to the email.
 */
@Processor(QUEUE_NAMES.NOTIFICATIONS)
export class WelcomeEmailProcessor extends WorkerHost {
  private readonly logger = new Logger(WelcomeEmailProcessor.name);

  constructor(private readonly communications: CommunicationsService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== JOB_NAMES.SEND_WELCOME_EMAIL) return;
    const { organizationId, email, phone, firstName, memberId } =
      job.data as SendWelcomeEmailJobData;

    if (
      phone &&
      (await this.communications.ownWhatsappNumberReady(organizationId))
    ) {
      try {
        const organization =
          await this.communications.organizationName(organizationId);
        await this.communications.send({
          organizationId,
          channel: 'WHATSAPP',
          category: 'TRANSACTIONAL',
          templateKey: 'welcome',
          recipient: phone,
          memberId,
          variables: { '1': firstName ?? '', '2': organization },
        });
        this.logger.log(`Queued WhatsApp welcome for member ${memberId}`);
        return;
      } catch (error) {
        this.logger.warn(
          `WhatsApp welcome failed for member ${memberId}, trying email: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }

    if (!email) return;
    await this.communications.sendWelcomeEmail(
      organizationId,
      email,
      firstName ?? '',
      memberId,
    );
    this.logger.log(`Sent welcome email for member ${memberId}`);
  }
}
