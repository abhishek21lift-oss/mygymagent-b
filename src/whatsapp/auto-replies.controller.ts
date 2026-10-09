import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { unsafeRegexReason } from '../automation/safe-regex';

class CreateAutoReplyRuleDto {
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

class UpdateAutoReplyRuleDto {
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

function validate(dto: CreateAutoReplyRuleDto): void {
  const keyword = (dto.keyword ?? '').trim();
  const answer = (dto.answer ?? '').trim();
  if (!keyword || keyword.length > 200) {
    throw new BadRequestException('keyword is required, max 200 characters');
  }
  if (!answer) throw new BadRequestException('answer is required');
  if (!['EXACT', 'CONTAINS', 'REGEX'].includes(dto.matchType)) {
    throw new BadRequestException('matchType must be EXACT, CONTAINS or REGEX');
  }
  if (!['ALL', 'PRIVATE', 'GROUP'].includes(dto.scope)) {
    throw new BadRequestException('scope must be ALL, PRIVATE or GROUP');
  }
  // A broken regex would never fire, and one that backtracks without end
  // would stall the API for every gym on the first message that trips it.
  // The matcher also skips either at runtime if one slips through.
  if (dto.matchType === 'REGEX') {
    const reason = unsafeRegexReason(keyword);
    if (reason) throw new BadRequestException(reason);
  }
}

@Controller('whatsapp/auto-replies')
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class AutoRepliesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermissions('whatsapp.read')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.prisma.autoReplyRule.findMany({
      where: { organizationId: user.organizationId! },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      take: 100,
    });
  }

  @Post()
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_auto_reply', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAutoReplyRuleDto,
  ) {
    validate(dto);
    return this.prisma.autoReplyRule.create({
      data: {
        organizationId: user.organizationId!,
        keyword: dto.keyword.trim(),
        matchType: dto.matchType,
        scope: dto.scope,
        answer: dto.answer.trim(),
        enabled: dto.enabled ?? true,
        priority: dto.priority ?? 0,
        createdByUserId: user.id,
      },
    });
  }

  @Patch(':id')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_auto_reply', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateAutoReplyRuleDto,
  ) {
    validate(dto);
    // Org-scoped by id: another gym's rule is 404, never 403.
    return this.prisma.autoReplyRule.updateMany({
      where: { id, organizationId: user.organizationId! },
      data: {
        keyword: dto.keyword.trim(),
        matchType: dto.matchType,
        scope: dto.scope,
        answer: dto.answer.trim(),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
      },
    });
  }

  @Delete(':id')
  @RequirePermissions('whatsapp.manage')
  @Audited({ resource: 'whatsapp_auto_reply', action: 'delete' })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    await this.prisma.autoReplyRule.deleteMany({
      where: { id, organizationId: user.organizationId! },
    });
    return { deleted: true };
  }
}
