import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '@prisma/client';
import type { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    userId: string,
    organizationId: string,
    unreadOnly = false,
    limit = 50,
  ) {
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const rows = await this.prisma.notification.findMany({
      where: {
        organizationId,
        userId,
        ...(unreadOnly ? { readAt: null } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: safeLimit,
    });
    const unreadCount = await this.prisma.notification.count({
      where: { organizationId, userId, readAt: null },
    });
    return { items: rows, unreadCount };
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
