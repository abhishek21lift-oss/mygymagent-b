import { Injectable, NotFoundException } from '@nestjs/common';
import {
  type FcmPushProvider,
  PushTokenInvalidError,
} from '../../communications/providers/fcm-push.provider';
import { PrismaService } from '../../prisma/prisma.service';

/** `NotificationDevice.channel` for an FCM registration token. FCM covers
 * Android, iOS (relayed to APNs) and web, so one value serves all three. */
export const FCM_DEVICE_CHANNEL = 'FCM';

/** A person rarely has more than a phone, a tablet and a browser or two.
 * Beyond this the oldest registrations are the ones that are stale. */
const MAX_DEVICES_PER_USER = 10;

/**
 * The caller's own push devices.
 *
 * Every method is keyed on the authenticated user and their organization,
 * both from the JWT -- never on anything in the request -- so there is no
 * route here through which one person could list, remove or register a
 * device as someone else.
 */
@Injectable()
export class PushDevicesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent, and re-homing: an FCM token identifies an app install, not
   * a person. When a phone is signed out and someone else signs in on it,
   * the same token arrives under a new user, and the previous owner's row
   * must go -- otherwise the first person keeps receiving the second
   * person's notifications. Any existing row for the token is therefore
   * removed, in any organization, before it is recorded for the caller.
   * Holding the token is what proves the caller is on that device.
   */
  async register(organizationId: string, userId: string, token: string) {
    const member = await this.prisma.member.findFirst({
      where: { organizationId, userId, deletedAt: null },
      select: { id: true },
    });
    return this.prisma.$transaction(async (tx) => {
      await tx.notificationDevice.deleteMany({
        where: { channel: FCM_DEVICE_CHANNEL, address: token },
      });
      const device = await tx.notificationDevice.create({
        data: {
          organizationId,
          userId,
          memberId: member?.id ?? null,
          channel: FCM_DEVICE_CHANNEL,
          address: token,
        },
        select: { id: true, active: true, createdAt: true },
      });
      const stale = await tx.notificationDevice.findMany({
        where: { organizationId, userId, channel: FCM_DEVICE_CHANNEL },
        orderBy: { createdAt: 'desc' },
        skip: MAX_DEVICES_PER_USER,
        select: { id: true },
      });
      if (stale.length) {
        await tx.notificationDevice.deleteMany({
          where: { id: { in: stale.map((d) => d.id) } },
        });
      }
      return device;
    });
  }

  /** The token itself is never returned: it is a delivery credential for
   * that device, and the client already holds its own. */
  list(organizationId: string, userId: string) {
    return this.prisma.notificationDevice.findMany({
      where: { organizationId, userId, channel: FCM_DEVICE_CHANNEL },
      orderBy: { createdAt: 'desc' },
      select: { id: true, active: true, createdAt: true },
    });
  }

  /** Another user's device id answers exactly like one that does not exist. */
  async remove(organizationId: string, userId: string, id: string) {
    const result = await this.prisma.notificationDevice.deleteMany({
      where: { id, organizationId, userId },
    });
    if (result.count === 0) throw new NotFoundException('Device not found');
    return { removed: true };
  }

  /** Sign-out path: the client knows its token, not the row id. */
  async removeByToken(organizationId: string, userId: string, token: string) {
    const result = await this.prisma.notificationDevice.deleteMany({
      where: {
        organizationId,
        userId,
        channel: FCM_DEVICE_CHANNEL,
        address: token,
      },
    });
    return { removed: result.count > 0 };
  }

  /** A dead token found here is deactivated, the same as in delivery. */
  async sendTest(organizationId: string, userId: string, fcm: FcmPushProvider) {
    const devices = await this.activeDevicesFor(organizationId, [userId]);
    const results: Array<{ deviceId: string; ok: boolean; error?: string }> =
      [];
    for (const device of devices) {
      try {
        await fcm.sendToToken(device.address, {
          title: 'Push is working',
          body: 'This device will receive your MyGymAgent notifications.',
          data: { type: 'PUSH_TEST' },
        });
        results.push({ deviceId: device.id, ok: true });
      } catch (error) {
        if (error instanceof PushTokenInvalidError) {
          await this.deactivate(device.id);
        }
        results.push({
          deviceId: device.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { devices: results.length, results };
  }

  activeDevicesFor(organizationId: string, userIds: string[]) {
    return this.prisma.notificationDevice.findMany({
      where: {
        organizationId,
        userId: { in: userIds },
        channel: FCM_DEVICE_CHANNEL,
        active: true,
      },
      select: { id: true, userId: true, memberId: true, address: true },
    });
  }

  deactivate(id: string) {
    return this.prisma.notificationDevice.updateMany({
      where: { id },
      data: { active: false },
    });
  }
}
