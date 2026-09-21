import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CommunicationsModule } from '../communications/communications.module';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { MemberCreatedListener } from './member-created.listener';
import { DomainNotificationListener } from './domain-notification.listener';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { WelcomeEmailProcessor } from './welcome-email.processor';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_NAMES.NOTIFICATIONS }),
    CommunicationsModule,
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    MemberCreatedListener,
    DomainNotificationListener,
    WelcomeEmailProcessor,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
