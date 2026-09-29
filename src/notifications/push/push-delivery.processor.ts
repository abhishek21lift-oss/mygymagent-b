import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { ChannelNotConfiguredError } from '../../communications/interfaces/email-provider.interface';
import {
  FcmPushProvider,
  PushTokenInvalidError,
} from '../../communications/providers/fcm-push.provider';
import { PrismaService } from '../../prisma/prisma.service';
import { JOB_NAMES, QUEUE_NAMES } from '../../queue/queue.constants';
import type { DeliverPushJobData } from './push-dispatch.service';
import { PushDevicesService } from './push-devices.service';

/**
 * Sends one push to one device and records the outcome in `MessageLog`,
 * the same audit trail every other channel writes to.
 *
 * Three outcomes, handled differently on purpose:
 *  - sent: logged SENT with FCM's message name;
 *  - the token is dead (uninstalled, signed out): the device is
 *    deactivated and the job ends -- retrying a dead token only fails
 *    three times instead of once;
 *  - anything else (FCM 5xx, a timeout, a rate limit): thrown, so the
 *    queue retries with backoff, and logged FAILED only on the last
 *    attempt, so one flaky minute is not recorded as a lost message.
 *
 * `recipient` is `device:<id>`, never the token: the log is readable by
 * staff, and the token is a credential for that device.
 */
@Processor(QUEUE_NAMES.PUSH)
export class PushDeliveryProcessor extends WorkerHost {
  private readonly logger = new Logger(PushDeliveryProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fcm: FcmPushProvider,
    private readonly devices: PushDevicesService,
  ) {
    super();
  }

  async process(job: Job<DeliverPushJobData>): Promise<void> {
    if (job.name !== JOB_NAMES.DELIVER_PUSH) {
      // This queue carries push only; an unknown job is a producer bug and
      // must fail loudly rather than complete unsent.
      throw new UnrecoverableError(`Unknown push job "${job.name}"`);
    }
    const data = job.data;
    const device = await this.prisma.notificationDevice.findFirst({
      where: {
        id: data.deviceId,
        organizationId: data.organizationId,
        active: true,
      },
      select: { id: true, address: true },
    });
    // Unregistered or re-homed since the job was queued: nothing to send,
    // and nothing went wrong.
    if (!device) return;

    const log = (status: 'SENT' | 'FAILED', extra: object = {}) =>
      this.prisma.messageLog.create({
        data: {
          organizationId: data.organizationId,
          channel: 'PUSH',
          category: 'TRANSACTIONAL',
          templateKey: `notification:${data.type}`,
          recipient: `device:${device.id}`,
          memberId: data.memberId,
          status,
          attempts: job.attemptsMade + 1,
          ...(status === 'SENT' ? { sentAt: new Date() } : {}),
          ...extra,
        },
      });

    try {
      const name = await this.fcm.sendToToken(device.address, {
        title: data.title,
        body: data.body,
        url: data.actionUrl,
        data: { type: data.type, category: data.category },
      });
      await log('SENT', { providerMessageId: name });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      if (error instanceof PushTokenInvalidError) {
        await this.devices.deactivate(device.id);
        await log('FAILED', { errorMessage });
        return;
      }
      if (error instanceof ChannelNotConfiguredError) {
        await log('FAILED', { errorMessage });
        throw new UnrecoverableError(errorMessage);
      }
      const maxAttempts = job.opts.attempts ?? 1;
      if (job.attemptsMade + 1 >= maxAttempts) {
        await log('FAILED', { errorMessage });
      }
      this.logger.warn(
        `Push to device ${device.id} failed (attempt ${job.attemptsMade + 1}/${maxAttempts}): ${errorMessage}`,
      );
      throw error;
    }
  }
}
