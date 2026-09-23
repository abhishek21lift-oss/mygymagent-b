/* eslint-disable prettier/prettier */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '@prisma/client';
import type { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import {
  isNotificationCategory,
  NOTIFICATION_CATEGORY_KEYS,
  type NotificationCategory,
} from './notification-categories';

type NotificationCursor = { createdAt: string; id: string };

export interface NotificationInput {
  type: string;
  title: string;
  body: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
  branchId?: string | null;
  actorUserId?: string | null;
  recipientUserIds?: string[];
  /**
   * Required, and one of the catalog's ten. It used to be optional, with
   * `category ?? type` as the fallback -- which meant a handler that
   * forgot it published under its *type* (`PAYMENT_RECORDED`), a category
   * the preferences screen never shows and no user can ever mute. The
   * type is the event; the category is the thing a person opts out of.
   */
  category: NotificationCategory;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  entityType?: string;
  entityId?: string;
  groupKey?: string;
  dedupeKey?: string;
  expiresAt?: Date;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  private encodeCursor(cursor: NotificationCursor) {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeCursor(value?: string): NotificationCursor | undefined {
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as Partial<NotificationCursor>;
      if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string')
        return undefined;
      const date = new Date(parsed.createdAt);
      return Number.isFinite(date.getTime())
        ? { createdAt: date.toISOString(), id: parsed.id }
        : undefined;
    } catch {
      return undefined;
    }
  }

  private activeWhere(now = new Date()): Prisma.NotificationWhereInput {
    return {
      archivedAt: null,
      OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    };
  }

  async list(
    userId: string,
    organizationId: string,
    unreadOnly = false,
    limit = 50,
    type?: string,
    search?: string,
    cursor?: string,
    category?: string,
    priority?: string,
    includeArchived = false,
  ) {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const normalizedType = type?.trim().toUpperCase();
    const normalizedCategory = category?.trim().toUpperCase();
    const normalizedPriority = priority?.trim().toUpperCase();
    const normalizedSearch = search?.trim();
    const decodedCursor = this.decodeCursor(cursor);
    const where: Prisma.NotificationWhereInput = {
      organizationId,
      userId,
      ...(includeArchived ? {} : this.activeWhere()),
      ...(unreadOnly ? { readAt: null } : {}),
      ...(normalizedType ? { type: normalizedType } : {}),
      ...(normalizedCategory ? { category: normalizedCategory } : {}),
      ...(normalizedPriority ? { priority: normalizedPriority } : {}),
      ...(normalizedSearch
        ? {
            OR: [
              { title: { contains: normalizedSearch, mode: 'insensitive' } },
              { body: { contains: normalizedSearch, mode: 'insensitive' } },
              {
                entityType: { contains: normalizedSearch, mode: 'insensitive' },
              },
              { entityId: { contains: normalizedSearch, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const cursorWhere = decodedCursor
      ? {
          AND: [
            where,
            {
              OR: [
                { createdAt: { lt: new Date(decodedCursor.createdAt) } },
                {
                  createdAt: new Date(decodedCursor.createdAt),
                  id: { lt: decodedCursor.id },
                },
              ],
            },
          ],
        }
      : where;

    const rows = await this.prisma.notification.findMany({
      where: cursorWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: safeLimit + 1,
    });
    const hasMore = rows.length > safeLimit;
    const items = hasMore ? rows.slice(0, safeLimit) : rows;
    const last = items.at(-1);
    const nextCursor =
      hasMore && last
        ? this.encodeCursor({
            createdAt: last.createdAt.toISOString(),
            id: last.id,
          })
        : null;

    const unreadCount = await this.prisma.notification.count({
      where: { organizationId, userId, ...this.activeWhere(), readAt: null },
    });
    return { items, unreadCount, hasMore, nextCursor };
  }

  async markRead(userId: string, organizationId: string, id: string) {
    const existing = await this.prisma.notification.findFirst({
      where: { id, organizationId, userId },
      select: { id: true, readAt: true },
    });
    if (!existing) throw new NotFoundException('Notification not found');
    if (existing.readAt) return existing;
    return this.prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
  }

  async markUnread(userId: string, organizationId: string, id: string) {
    const existing = await this.prisma.notification.findFirst({
      where: { id, organizationId, userId },
      select: { id: true, readAt: true },
    });
    if (!existing) throw new NotFoundException('Notification not found');
    return this.prisma.notification.update({
      where: { id },
      data: { readAt: null },
    });
  }

  async markAllRead(userId: string, organizationId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { organizationId, userId, ...this.activeWhere(), readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  async archive(userId: string, organizationId: string, id: string) {
    const existing = await this.prisma.notification.findFirst({
      where: { id, organizationId, userId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Notification not found');
    return this.prisma.notification.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
  }

  async unarchive(userId: string, organizationId: string, id: string) {
    const existing = await this.prisma.notification.findFirst({
      where: { id, organizationId, userId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Notification not found');
    return this.prisma.notification.update({
      where: { id },
      data: { archivedAt: null },
    });
  }

  async snooze(
    userId: string,
    organizationId: string,
    id: string,
    until: Date,
  ) {
    if (!Number.isFinite(until.getTime()) || until <= new Date())
      throw new BadRequestException('Snooze time must be in the future');
    const existing = await this.prisma.notification.findFirst({
      where: { id, organizationId, userId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Notification not found');
    return this.prisma.notification.update({
      where: { id },
      data: { snoozedUntil: until },
    });
  }

  async delete(userId: string, organizationId: string, id: string) {
    const existing = await this.prisma.notification.findFirst({
      where: { id, organizationId, userId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Notification not found');
    await this.prisma.notification.delete({ where: { id } });
    return { deleted: true };
  }

  async getPreferences(userId: string, organizationId: string) {
    return this.prisma.notificationPreference.findMany({
      where: { organizationId, userId },
      orderBy: { category: 'asc' },
    });
  }

  async updatePreferences(
    userId: string,
    organizationId: string,
    category: string,
    dto: UpdateNotificationPreferencesDto,
  ) {
    const normalizedCategory = category.trim().toUpperCase();
    // B-P0-11: an unrecognised category used to be stored happily and then
    // matched nothing -- the user saw their opt-out save and kept getting
    // notified. Reject it instead, and name the ten that exist so the
    // caller can see what they meant.
    if (!isNotificationCategory(normalizedCategory))
      throw new BadRequestException(
        `Unknown notification category '${category}'. Expected one of: ${NOTIFICATION_CATEGORY_KEYS.join(', ')}.`,
      );
    return this.prisma.notificationPreference.upsert({
      where: {
        organizationId_userId_category: {
          organizationId,
          userId,
          category: normalizedCategory,
        },
      },
      create: { organizationId, userId, category: normalizedCategory, ...dto },
      update: { ...dto },
    });
  }

  async notifyOrganization(organizationId: string, input: NotificationInput) {
    const recipientIds = input.recipientUserIds?.length
      ? [...new Set(input.recipientUserIds)]
      : (
          await this.prisma.user.findMany({
            where: {
              organizationId,
              deletedAt: null,
              status: 'ACTIVE',
              ...(input.branchId
                ? {
                    OR: [
                      { primaryBranchId: input.branchId },
                      { staffProfile: { branchId: input.branchId } },
                      { userRoles: { some: { branchId: input.branchId } } },
                      {
                        userRoles: { some: { organizationId, branchId: null } },
                      },
                    ],
                  }
                : {}),
            },
            select: { id: true },
          })
        ).map((user) => user.id);

    if (!recipientIds.length) return { created: 0 };

    const { category } = input;
    const preferences = await this.prisma.notificationPreference.findMany({
      where: { organizationId, userId: { in: recipientIds }, category },
      select: { userId: true, inApp: true },
    });
    const optedOut = new Set(
      preferences.filter((p) => !p.inApp).map((p) => p.userId),
    );
    const recipients = recipientIds.filter((id) => !optedOut.has(id));
    if (!recipients.length) return { created: 0 };

    // Time-bucket the default dedupe key so recurring events (low stock,
    // restarted memberships) can notify again on a later day instead of
    // being permanently suppressed by the unique constraint.
    const dayBucket = new Date().toISOString().slice(0, 10);
    const dedupeKey =
      input.dedupeKey ??
      (input.entityId
        ? `${input.type}:${input.entityId}:${dayBucket}`
        : undefined);
    const data = recipients.map((userId) => ({
      organizationId,
      userId,
      branchId: input.branchId ?? null,
      actorUserId: input.actorUserId ?? null,
      type: input.type,
      category,
      priority: input.priority ?? 'NORMAL',
      title: input.title,
      body: input.body,
      actionUrl: input.actionUrl,
      entityType: input.entityType,
      entityId: input.entityId,
      groupKey: input.groupKey,
      dedupeKey,
      metadata: input.metadata as Prisma.InputJsonValue,
      expiresAt: input.expiresAt,
    }));
    const result = await this.prisma.notification.createMany({
      data,
      skipDuplicates: true,
    });
    return { created: result.count };
  }

  async createInApp(
    input: NotificationInput & { organizationId: string; userId: string },
  ) {
    const preference = await this.prisma.notificationPreference.findUnique({
      where: {
        organizationId_userId_category: {
          organizationId: input.organizationId,
          userId: input.userId,
          category: input.category,
        },
      },
      select: { inApp: true },
    });
    if (preference?.inApp === false) return null;
    return this.prisma.notification.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        branchId: input.branchId ?? null,
        actorUserId: input.actorUserId ?? null,
        type: input.type,
        category: input.category,
        priority: input.priority ?? 'NORMAL',
        title: input.title,
        body: input.body,
        actionUrl: input.actionUrl,
        entityType: input.entityType,
        entityId: input.entityId,
        groupKey: input.groupKey,
        dedupeKey: input.dedupeKey,
        metadata: input.metadata as Prisma.InputJsonValue,
        expiresAt: input.expiresAt,
      },
    });
  }
}
