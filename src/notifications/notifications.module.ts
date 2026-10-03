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
import { MemberDirectPushService } from './push/member-direct-push.service';

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
    MemberDirectPushService,
  ],
  // Re-exported so a monitoring surface can read queue depth without
  // registering the same queue a second time. A second
  // `BullModule.registerQueue` for an existing name produces a distinct
  // Queue object over the same Redis keys, which broke
  // automation-overview.e2e-spec's `app.get(getQueueToken(AUTOMATION))`
  // spy: the token resolved to the other instance.
  exports: [
    NotificationsService,
    MemberPushService,
    MemberDirectPushService,
    BullModule,
  ],
})
export class NotificationsModule {}
