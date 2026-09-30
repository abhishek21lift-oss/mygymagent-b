import {
  BadRequestException,
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  FcmPushProvider,
  PushTokenInvalidError,
} from '../../communications/providers/fcm-push.provider';
import { PrismaService } from '../../prisma/prisma.service';
import { PushDevicesService } from './push-devices.service';

/**
 * A push a member of staff writes to one member ("Send message" on the
 * member profile, channel PUSH).
 *
 * It used to go through `CommunicationsService`, which only knows "one
 * recipient address": the member's *phone number* was handed to FCM as if
 * it were a device token, so the message could only ever fail. A push
 * belongs to the member's own app devices -- the ones they turned
 * notifications on for under their login -- so it is sent here, device by
 * device.
 *
 * Synchronous, unlike event pushes: the person who pressed Send is
 * waiting to hear whether it went. Every attempt is written to
 * `MessageLog` as `device:<id>` (never the token), so it appears in the
 * member's message history beside email and WhatsApp.
 */
@Injectable()
export class MemberDirectPushService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fcm: FcmPushProvider,
    private readonly devices: PushDevicesService,
  ) {}

  async send(
    organizationId: string,
    member: { id: string; userId: string | null },
    message: { title: string; body: string },
  ) {
    if (!this.fcm.isConfigured()) {
      throw new ServiceUnavailableException(
        'Push notifications are not set up on this workspace yet.',
      );
    }
    if (!member.userId) {
      throw new BadRequestException(
        "This member doesn't use the app yet, so there is nowhere to send a push. Invite them to the member app first.",
      );
    }
    const targets = await this.devices.activeDevicesFor(organizationId, [
      member.userId,
    ]);
    if (!targets.length) {
      throw new BadRequestException(
        "This member hasn't turned on notifications in the app on any device.",
      );
    }

    const logs = [];
    for (const device of targets) {
      const base = {
        organizationId,
        channel: 'PUSH' as const,
        category: 'TRANSACTIONAL' as const,
        templateKey: 'ad_hoc',
        recipient: `device:${device.id}`,
        memberId: member.id,
        attempts: 1,
      };
      try {
        const name = await this.fcm.sendToToken(device.address, {
          title: message.title,
          body: message.body,
          url: '/portal',
          data: { type: 'STAFF_MESSAGE' },
        });
        logs.push(
          await this.prisma.messageLog.create({
            data: {
              ...base,
              status: 'SENT',
              sentAt: new Date(),
              providerMessageId: name,
            },
          }),
        );
      } catch (error) {
        if (error instanceof PushTokenInvalidError) {
          await this.devices.deactivate(device.id);
        }
        logs.push(
          await this.prisma.messageLog.create({
            data: {
              ...base,
              status: 'FAILED',
              errorMessage:
                error instanceof Error ? error.message : String(error),
            },
          }),
        );
      }
    }

    const sent = logs.find((log) => log.status === 'SENT');
    if (!sent) {
      throw new BadGatewayException(
        "The push couldn't be delivered to any of this member's devices. The attempts are in their message history.",
      );
    }
    return sent;
  }
}
