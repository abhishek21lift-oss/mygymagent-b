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
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

class AutoReplyRuleDto {
  keyword!: string;
  matchType!: 'EXACT' | 'CONTAINS' | 'REGEX';
  scope!: 'ALL' | 'PRIVATE' | 'GROUP';
  answer!: string;
  enabled?: boolean;
  priority?: number;
}

function validate(dto: AutoReplyRuleDto): void {
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
  // A rule saved with a broken regex would never fire; reject it here too
  // (the matcher also skips it at runtime if one slips through).
  if (dto.matchType === 'REGEX') {
    try {
      new RegExp(keyword, 'i');
    } catch {
      throw new BadRequestException(
        'keyword is not a valid regular expression',
      );
    }
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
    @Body() dto: AutoReplyRuleDto,
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
    @Body() dto: AutoReplyRuleDto,
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
