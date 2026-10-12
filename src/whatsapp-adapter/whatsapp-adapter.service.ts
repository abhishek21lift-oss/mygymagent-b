import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WaSessionManager } from '../whatsapp-web/wa-session.manager';
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

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
      displayPhoneNumber: liveStatus === 'CONNECTED' ? session.phoneNumber : null,
      qrDataUrl,
      pairingCode,
      connectedAt: session.connectedAt?.toISOString() ?? null,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      lastError: session.lastError ?? null,
    };
  }

  private mapStatus(status: 'CONNECTED' | 'PAIRING' | 'DISCONNECTED' | 'LOGGED_OUT'): 'CONNECTED' | 'PAIRING' | 'DISCONNECTED' | 'LOGGED_OUT' | 'NOT_CONNECTED' {
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
  async listAutoReplies(organizationId: string, limit?: number, search?: string) {
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

  async createAutoReply(organizationId: string, dto: CreateAutoReplyDto, createdByUserId: string | null = null) {
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

  async updateAutoReply(organizationId: string, id: string, dto: UpdateAutoReplyDto) {
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
