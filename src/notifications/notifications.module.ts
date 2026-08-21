import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MailerService } from '../common/mailer/mailer.service';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { MemberCreatedListener } from './member-created.listener';
import { WelcomeEmailProcessor } from './welcome-email.processor';

/**
 * First real capability, not yet the full design in docs/ARCHITECTURE.md's
 * notification-architecture section -- see README.md for exactly what's
 * built (one event, one queue, one job type) vs. still a stub
 * (in-app/SMS/WhatsApp/push channels, templates, delivery tracking).
 */
@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_NAMES.NOTIFICATIONS })],
  providers: [MemberCreatedListener, WelcomeEmailProcessor, MailerService],
})
export class NotificationsModule {}
