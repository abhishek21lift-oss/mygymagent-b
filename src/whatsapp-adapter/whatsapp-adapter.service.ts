import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WaSessionManager } from '../whatsapp-web/wa-session.manager';
import type { WaGroupRow } from '../whatsapp-web/wa-types';
import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';

@Injectable()
export class WhatsAppAdapterService {
  private readonly logger = new Logger(WhatsAppAdapterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly manager: WaSessionManager,
  ) {}

  async getStatus(organizationId: string) {
    const [liveStatus, session] = await Promise.all([
      this.manager.getStatus(organizationId),
      this.prisma.waSession.findUnique({
        where: { organizationId },
        select: {
          id: true,
          phoneNumber: true,
          lastError: true,
          connectedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);

    if (!session) {
      return {
        status: 'NOT_CONNECTED' as const,
        phoneNumber: null,
        displayPhoneNumber: null,
        qrDataUrl: null,
        pairingCode: null,
        connectedAt: null,
        createdAt: null,
        updatedAt: null,
        lastError: null,
      };
    }

    const { qrDataUrl, pairingCode } = await this.manager.codes(organizationId);

    return {
      id: session.id,
      organizationId,
      status: this.mapStatus(liveStatus),
      phoneNumber: session.phoneNumber,
      displayPhoneNumber:
        liveStatus === 'CONNECTED' ? session.phoneNumber : null,
      qrDataUrl,
      pairingCode,
      connectedAt: session.connectedAt?.toISOString() ?? null,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      lastError: session.lastError ?? null,
    };
  }

  private mapStatus(
    status: 'CONNECTED' | 'PAIRING' | 'DISCONNECTED' | 'LOGGED_OUT',
  ): 'CONNECTED' | 'PAIRING' | 'DISCONNECTED' | 'LOGGED_OUT' | 'NOT_CONNECTED' {
    switch (status) {
      case 'CONNECTED':
        return 'CONNECTED';
      case 'PAIRING':
        return 'PAIRING';
      case 'DISCONNECTED':
        return 'DISCONNECTED';
      case 'LOGGED_OUT':
        return 'LOGGED_OUT';
      default:
        return 'NOT_CONNECTED';
    }
  }

  // AutoReply CRUD
  async listAutoReplies(
    organizationId: string,
    limit?: number,
    search?: string,
  ) {
    const take = Math.min(Math.max(limit ?? 100, 1), 200);
    let where: Prisma.AutoReplyRuleWhereInput = { organizationId };
    if (search) {
      where = {
        AND: [
          { organizationId },
          {
            OR: [
              { keyword: { contains: search, mode: 'insensitive' } },
              { answer: { contains: search, mode: 'insensitive' } },
            ],
          },
        ],
      };
    }
    return this.prisma.autoReplyRule.findMany({
      where,
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      take,
    });
  }

  // Address-book lookup for the gym's linked number (same waContact rows as
  // the inbox lookup aid), plus optional case-insensitive search. Read-only.
  async listContacts(organizationId: string, limit?: number, search?: string) {
    const take = Math.min(Math.max(limit ?? 100, 1), 200);
    const session = await this.prisma.waSession.findUnique({
      where: { organizationId },
      select: { id: true },
    });
    if (!session) return [];
    const trimmed = search?.trim();
    return this.prisma.waContact.findMany({
      where: trimmed
        ? {
            sessionId: session.id,
            OR: [
              { jid: { contains: trimmed, mode: 'insensitive' } },
              { name: { contains: trimmed, mode: 'insensitive' } },
              { notify: { contains: trimmed, mode: 'insensitive' } },
            ],
          }
        : { sessionId: session.id },
      orderBy: { updatedAt: 'desc' },
      take,
      select: { jid: true, name: true, notify: true, updatedAt: true },
    });
  }

  /**
   * Groups the gym's linked number participates in. Read-only live metadata
   * via the org's own open session — no persistence, no mutations.
   * `{ available: false }` when the session is not open, the fetch times
   * out, or WhatsApp errors, so callers can show an unavailable state
   * instead of mistaking it for "no groups".
   */
  async listGroups(
    organizationId: string,
    limit?: number,
  ): Promise<{ available: boolean; groups: WaGroupRow[] }> {
    const take = Math.min(Math.max(limit ?? 100, 1), 200);
    const groups = await this.manager.listGroups(organizationId);
    if (!groups) return { available: false, groups: [] };
    return { available: true, groups: groups.slice(0, take) };
  }

  /**
   * Recent automatic WhatsApp answers (bot commands, welcome, gym
   * intents): same `auto_reply.*` rows the hourly cap and duplicate
   * guards read. Metadata only -- never message bodies.
   */
  async automationActivity(organizationId: string, limit?: number) {
    const take = Math.min(Math.max(limit ?? 50, 1), 200);
    return this.prisma.messageLog.findMany({
      where: {
        organizationId,
        channel: 'WHATSAPP',
        templateKey: { startsWith: 'auto_reply.' },
      },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        templateKey: true,
        recipient: true,
        status: true,
        createdAt: true,
      },
    });
  }

  async createAutoReply(
    organizationId: string,
    dto: CreateAutoReplyDto,
    createdByUserId: string | null = null,
  ) {
    return this.prisma.autoReplyRule.create({
      data: {
        organizationId,
        keyword: dto.keyword.trim(),
        matchType: dto.matchType,
        scope: dto.scope,
        answer: dto.answer.trim(),
        enabled: dto.enabled ?? true,
        priority: dto.priority ?? 0,
        createdByUserId,
      },
    });
  }

  async updateAutoReply(
    organizationId: string,
    id: string,
    dto: UpdateAutoReplyDto,
  ) {
    const data: Prisma.AutoReplyRuleUpdateManyMutationInput = {};
    if (dto.keyword !== undefined) data.keyword = dto.keyword.trim();
    if (dto.matchType !== undefined) data.matchType = dto.matchType;
    if (dto.scope !== undefined) data.scope = dto.scope;
    if (dto.answer !== undefined) data.answer = dto.answer.trim();
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.priority !== undefined) data.priority = dto.priority;

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('nothing to update');
    }

    return this.prisma.autoReplyRule.updateMany({
      where: { id, organizationId },
      data,
    });
  }

  async deleteAutoReply(organizationId: string, id: string) {
    return this.prisma.autoReplyRule.deleteMany({
      where: { id, organizationId },
    });
  }

  async getBotConfig(organizationId: string) {
    return this.prisma.botConfig.findUnique({
      where: { organizationId },
    });
  }

  // Upsert: absence of a row means every behavior is off. Only whitelisted
  // fields are ever written; an empty patch is rejected.
  async updateBotConfig(organizationId: string, dto: UpdateBotConfigDto) {
    let prefix: string | undefined;
    if (dto.prefix !== undefined) {
      const trimmed = dto.prefix.trim();
      if (trimmed.length < 1 || trimmed.length > 3) {
        throw new BadRequestException('prefix must be 1 to 3 characters');
      }
      prefix = trimmed;
    }
    let welcomeMessage: string | null | undefined;
    if (dto.welcomeMessage !== undefined) {
      if (dto.welcomeMessage === null) {
        welcomeMessage = null;
      } else {
        const message = dto.welcomeMessage.trim();
        if (message.length > 1000) {
          throw new BadRequestException(
            'welcomeMessage must be at most 1000 characters',
          );
        }
        welcomeMessage = message === '' ? null : message;
      }
    }
    const data: Prisma.BotConfigUpdateInput = {};
    if (prefix !== undefined) data.prefix = prefix;
    if (dto.enablePing !== undefined) data.enablePing = dto.enablePing;
    if (dto.enableUptime !== undefined) data.enableUptime = dto.enableUptime;
    if (welcomeMessage !== undefined) data.welcomeMessage = welcomeMessage;

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('nothing to update');
    }

    return this.prisma.botConfig.upsert({
      where: { organizationId },
      create: {
        organizationId,
        prefix: prefix ?? '#',
        enablePing: dto.enablePing ?? false,
        enableUptime: dto.enableUptime ?? false,
        welcomeMessage: welcomeMessage ?? null,
      },
      update: data,
    });
  }
}

// DTOs
export class CreateAutoReplyDto {
  @IsString()
  keyword!: string;

  @IsString()
  matchType!: 'EXACT' | 'CONTAINS' | 'REGEX';

  @IsString()
  scope!: 'ALL' | 'PRIVATE' | 'GROUP';

  @IsString()
  answer!: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsNumber()
  priority?: number;
}

export class UpdateAutoReplyDto {
  // Every field optional: class-validator rejects `undefined` for a
  // decorated rule unless @IsOptional() is present, so a partial PATCH
  // (e.g. a toggle sending only `enabled`) would 400 without these.
  @IsOptional()
  @IsString()
  keyword?: string;

  @IsOptional()
  @IsString()
  matchType?: 'EXACT' | 'CONTAINS' | 'REGEX';

  @IsOptional()
  @IsString()
  scope?: 'ALL' | 'PRIVATE' | 'GROUP';

  @IsOptional()
  @IsString()
  answer?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsNumber()
  priority?: number;
}

export class UpdateBotConfigDto {
  // Command trigger, e.g. "#" for "#ping". Length is enforced in the
  // service (after trimming) so a whitespace-only prefix is rejected too.
  @IsOptional()
  @IsString()
  prefix?: string;

  @IsOptional()
  @IsBoolean()
  enablePing?: boolean;

  @IsOptional()
  @IsBoolean()
  enableUptime?: boolean;

  // Null or blank clears the greeting and disables it.
  @IsOptional()
  @IsString()
  welcomeMessage?: string | null;
}
