import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '@prisma/client';
import type { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';

type NotificationCursor = { createdAt: string; id: string };

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  private encodeCursor(cursor: NotificationCursor) {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeCursor(value?: string): NotificationCursor | undefined {
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<NotificationCursor>;
      if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return undefined;
      const date = new Date(parsed.createdAt);
      if (!Number.isFinite(date.getTime())) return undefined;
      return { createdAt: date.toISOString(), id: parsed.id };
    } catch {
      return undefined;
    }
  }

  async list(
    userId: string,
    organizationId: string,
    unreadOnly = false,
    limit = 50,
    type?: string,
    search?: string,
    cursor?: string,
  ) {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const normalizedType = type?.trim().toUpperCase();
    const normalizedSearch = search?.trim();
    const decodedCursor = this.decodeCursor(cursor);

    const baseWhere: Prisma.NotificationWhereInput = {
      organizationId,
      userId,
      ...(unreadOnly ? { readAt: null } : {}),
      ...(normalizedType ? { type: normalizedType } : {}),
      ...(normalizedSearch
        ? {
            OR: [
              { title: { contains: normalizedSearch, mode: 'insensitive' } },
              { body: { contains: normalizedSearch, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const cursorWhere = decodedCursor
      ? {
          AND: [
            baseWhere,
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
      : baseWhere;

    const rows = await this.prisma.notification.findMany({
      where: cursorWhere,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: safeLimit + 1,
    });

    const hasMore = rows.length > safeLimit;
    const items = hasMore ? rows.slice(0, safeLimit) : rows;
    const last = items.at(-1);
    const nextCursor = hasMore && last
      ? this.encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
      : null;

    const unreadCount = await this.prisma.notification.count({
      where: { organizationId, userId, readAt: null },
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
    if (!existing.readAt) return existing;
    return this.prisma.notification.update({
      where: { id },
      data: { readAt: null },
    });
  }

  async markAllRead(userId: string, organizationId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { organizationId, userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
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
    if (!normalizedCategory) {
      throw new NotFoundException('Notification category is required');
    }
    return this.prisma.notificationPreference.upsert({
      where: {
        organizationId_userId_category: {
          organizationId,
          userId,
          category: normalizedCategory,
        },
      },
      create: {
        organizationId,
        userId,
        category: normalizedCategory,
        ...dto,
      },
      update: { ...dto },
    });
  }

  async notifyOrganization(
    organizationId: string,
    input: {
      type: string;
      title: string;
      body: string;
      actionUrl?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    const users = await this.prisma.user.findMany({
      where: {
        organizationId,
        deletedAt: null,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    if (users.length === 0) return { created: 0 };

    const category = input.type.trim().toUpperCase();
    const preferences = await this.prisma.notificationPreference.findMany({
      where: {
        organizationId,
        userId: { in: users.map((user) => user.id) },
        category,
      },
      select: { userId: true, inApp: true },
    });
    const optedOut = new Set(
      preferences
        .filter((preference) => !preference.inApp)
        .map((preference) => preference.userId),
    );
    const recipients = users.filter((user) => !optedOut.has(user.id));
    if (recipients.length === 0) return { created: 0 };

    const result = await this.prisma.notification.createMany({
      data: recipients.map((user) => ({
        organizationId,
        userId: user.id,
        type: input.type,
        title: input.title,
        body: input.body,
        actionUrl: input.actionUrl,
        metadata: input.metadata as Prisma.InputJsonValue,
      })),
    });
    return { created: result.count };
  }

  async createInApp(input: {
    organizationId: string;
    userId: string;
    type: string;
    title: string;
    body: string;
    actionUrl?: string;
    metadata?: Record<string, unknown>;
  }) {
    const preference = await this.prisma.notificationPreference.findUnique({
      where: {
        organizationId_userId_category: {
          organizationId: input.organizationId,
          userId: input.userId,
          category: input.type.toUpperCase(),
        },
      },
      select: { inApp: true },
    });
    if (preference?.inApp === false) return null;
    return this.prisma.notification.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        actionUrl: input.actionUrl,
        metadata: input.metadata as Prisma.InputJsonValue,
      },
    });
  }
}
