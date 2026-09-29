import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CommunicationsModule } from '../communications/communications.module';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { MemberCreatedListener } from './member-created.listener';
import { DomainNotificationListener } from './domain-notification.listener';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { WelcomeEmailProcessor } from './welcome-email.processor';
import { PushDeliveryProcessor } from './push/push-delivery.processor';
import { PushDevicesController } from './push/push-devices.controller';
import { PushDevicesService } from './push/push-devices.service';
import { PushDispatchService } from './push/push-dispatch.service';
import { MemberPushListener } from './push/member-push.listener';
import { MemberPushService } from './push/member-push.service';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUE_NAMES.NOTIFICATIONS },
      { name: QUEUE_NAMES.PUSH },
    ),
    CommunicationsModule,
  ],
  controllers: [NotificationsController, PushDevicesController],
  providers: [
    NotificationsService,
    MemberCreatedListener,
    DomainNotificationListener,
    WelcomeEmailProcessor,
    PushDevicesService,
    PushDispatchService,
    PushDeliveryProcessor,
    MemberPushService,
    MemberPushListener,
  ],
  exports: [NotificationsService, MemberPushService],
})
export class NotificationsModule {}
