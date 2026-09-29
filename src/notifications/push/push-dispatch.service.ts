import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { createHash } from 'crypto';
import { FcmPushProvider } from '../../communications/providers/fcm-push.provider';
import { PrismaService } from '../../prisma/prisma.service';
import { JOB_NAMES, QUEUE_NAMES } from '../../queue/queue.constants';
import { PushDevicesService } from './push-devices.service';

export interface PushNotificationInput {
  type: string;
  category: string;
  title: string;
  body: string;
  actionUrl?: string;
  /** The in-app notification's dedupe key. When present, the same event
   * never pushes to the same device twice while the job is retained
   * (24h, the same window as the in-app day bucket). */
  dedupeKey?: string;
}

export interface DeliverPushJobData {
  organizationId: string;
  deviceId: string;
  userId: string;
  memberId: string | null;
  type: string;
  category: string;
  title: string;
  body: string;
  actionUrl?: string;
}

/**
 * Turns an in-app notification into pushes for the people who asked for
 * them.
 *
 * Push is opt-in per category: `NotificationPreference.push` defaults to
 * false, and only an explicit `true` for that category sends. It is
 * independent of `inApp` -- someone can mute the bell and still want the
 * phone to buzz.
 *
 * One queue job per device, not per notification, so a retry resends to
 * the one device that failed and never to the ones that already got it.
 * The jobs live on their own queue: the `notifications` queue has a
 * processor that completes any job name it does not recognise, so a push
 * job there could be marked done without being sent.
 */
@Injectable()
export class PushDispatchService {
  private readonly logger = new Logger(PushDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: PushDevicesService,
    private readonly fcm: FcmPushProvider,
    @InjectQueue(QUEUE_NAMES.PUSH) private readonly queue: Queue,
  ) {}

  /**
   * Fire-and-forget. Never awaited by the notification path: during a
   * Redis outage `queue.add` stays pending rather than rejecting (see
   * member-created.listener.ts), and a push must not hold up the request
   * that raised the notification.
   */
  dispatch(
    organizationId: string,
    userIds: string[],
    input: PushNotificationInput,
  ): void {
    if (!userIds.length || !this.fcm.isConfigured()) return;
    void this.enqueue(organizationId, userIds, input).catch((error) => {
      this.logger.error(
        `Failed to enqueue push for ${input.type}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** Exposed for tests; production callers use `dispatch`. */
  async enqueue(
    organizationId: string,
    userIds: string[],
    input: PushNotificationInput,
  ): Promise<number> {
    const optedIn = await this.prisma.notificationPreference.findMany({
      where: {
        organizationId,
        userId: { in: [...new Set(userIds)] },
        category: input.category,
        push: true,
      },
      select: { userId: true },
    });
    if (!optedIn.length) return 0;

    const devices = await this.devices.activeDevicesFor(
      organizationId,
      optedIn.map((p) => p.userId),
    );
    if (!devices.length) return 0;

    await this.queue.addBulk(
      devices.map((device) => ({
        name: JOB_NAMES.DELIVER_PUSH,
        data: {
          organizationId,
          deviceId: device.id,
          userId: device.userId ?? '',
          memberId: device.memberId,
          type: input.type,
          category: input.category,
          title: input.title,
          body: input.body,
          actionUrl: input.actionUrl,
        } satisfies DeliverPushJobData,
        opts: input.dedupeKey
          ? { jobId: this.jobId(device.id, input.dedupeKey) }
          : undefined,
      })),
    );
    return devices.length;
  }

  /** BullMQ rejects `:` in custom ids, and dedupe keys contain them. */
  private jobId(deviceId: string, dedupeKey: string) {
    const digest = createHash('sha256')
      .update(`${deviceId}|${dedupeKey}`)
      .digest('hex')
      .slice(0, 40);
    return `push-${digest}`;
  }
}
