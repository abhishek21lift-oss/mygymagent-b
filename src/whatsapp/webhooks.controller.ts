import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import crypto from 'node:crypto';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PrismaService } from '../prisma/prisma.service';
import { WEBHOOK_EVENTS } from './webhook-events';
import { WebhookBlockedError, assertPublicUrl } from './webhook-ssrf';
import { postWebhook } from './webhook-send';

const MAX_SUBSCRIPTIONS = 10;

const PUBLIC_SUBSCRIPTION = {
  id: true,
  url: true,
  events: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

class WebhookDto {
  url?: string;
  events?: string[];
  enabled?: boolean;
}

function validateEvents(events: unknown): string[] {
  if (!Array.isArray(events) || events.length === 0) {
    throw new BadRequestException('events must be a non-empty array');
  }
  const known = [...WEBHOOK_EVENTS, '*'];
  for (const event of events) {
    if (typeof event !== 'string' || !known.includes(event)) {
      throw new BadRequestException(
        `unknown event "${String(event)}" (allowed: ${known.join(', ')})`,
      );
    }
  }
  return [...new Set(events as string[])];
}

async function validateUrl(url: unknown): Promise<string> {
  if (typeof url !== 'string' || !url.trim()) {
    throw new BadRequestException('url is required');
  }
  try {
    return await assertPublicUrl(url.trim());
  } catch (error) {
    if (error instanceof WebhookBlockedError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}

@Controller('whatsapp/webhooks')
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class WebhooksController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermissions('whatsapp.read')
  list(@CurrentUser() user: AuthenticatedUser) {
    // Secrets never leave the server except once, at create/regenerate.
    return this.prisma.webhookSubscription.findMany({
      where: { organizationId: user.organizationId! },
      select: PUBLIC_SUBSCRIPTION,
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
  }

  @Get('deliveries')
  @RequirePermissions('whatsapp.read')
  deliveries(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return this.prisma.webhookDelivery.findMany({
      where: { organizationId: user.organizationId! },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  @Post()
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_webhook', action: 'create' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WebhookDto,
  ) {
    const organizationId = user.organizationId!;
    const existing = await this.prisma.webhookSubscription.count({
      where: { organizationId },
    });
    if (existing >= MAX_SUBSCRIPTIONS) {
      throw new BadRequestException(
        `at most ${MAX_SUBSCRIPTIONS} webhook subscriptions per gym`,
      );
    }
    const url = await validateUrl(dto.url);
    const events = validateEvents(dto.events);
    return this.prisma.webhookSubscription.create({
      data: {
        organizationId,
        url,
        events,
        secret: crypto.randomBytes(32).toString('hex'),
        enabled: dto.enabled ?? true,
        createdByUserId: user.id,
      },
    });
  }

  @Patch(':id')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_webhook', action: 'update' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: WebhookDto,
  ) {
    // Org-scoped by id: another gym's subscription is 404, never 403.
    const data: {
      url?: string;
      events?: string[];
      enabled?: boolean;
    } = {};
    if (dto.url !== undefined) data.url = await validateUrl(dto.url);
    if (dto.events !== undefined) data.events = validateEvents(dto.events);
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('nothing to update');
    }
    return this.prisma.webhookSubscription.updateMany({
      where: { id, organizationId: user.organizationId! },
      data,
    });
  }

  @Delete(':id')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_webhook', action: 'delete' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    await this.prisma.webhookSubscription.deleteMany({
      where: { id, organizationId: user.organizationId! },
    });
    return { deleted: true };
  }

  @Post(':id/regenerate')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_webhook', action: 'regenerate' })
  async regenerate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    const secret = crypto.randomBytes(32).toString('hex');
    const { count } = await this.prisma.webhookSubscription.updateMany({
      where: { id, organizationId: user.organizationId! },
      data: { secret },
    });
    if (count === 0) throw new NotFoundException('Webhook not found');
    return { secret };
  }

  @Post(':id/test')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_webhook', action: 'test' })
  async test(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    const sub = await this.prisma.webhookSubscription.findFirst({
      where: { id, organizationId: user.organizationId! },
    });
    if (!sub) throw new NotFoundException('Webhook not found');
    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        organizationId: user.organizationId!,
        subscriptionId: sub.id,
        event: 'test',
      },
      select: { id: true },
    });
    try {
      const { httpStatus } = await postWebhook(sub.url, sub.secret, {
        event: 'test',
        organizationId: user.organizationId!,
        timestamp: new Date().toISOString(),
        data: { subscriptionId: sub.id },
      });
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'SENT', attempts: 1, httpStatus, error: null },
      });
      return { ok: true, httpStatus };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'FAILED', attempts: 1, error: message.slice(0, 500) },
      });
      return { ok: false, error: message };
    }
  }
}
