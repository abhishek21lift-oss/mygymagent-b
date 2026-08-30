import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AiActionsService } from './ai-actions.service';
import { ListAiActionsQueryDto } from './dto/list-ai-actions-query.dto';
import { RejectAiActionDto } from './dto/reject-ai-action.dto';

/** The Action Center's human-facing side: view AI-proposed changes and
 * approve/reject them. Every route requires `ai.approve` -- "can decide
 * on AI proposals" -- but approving one additionally re-checks the
 * *approver* holds the underlying resource permission the proposed
 * action itself needs (see AiActionsService.approve()'s comment); this
 * guard alone is not sufficient to actually approve anything. */
@Controller('ai-actions')
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AiActionsController {
  constructor(private readonly aiActions: AiActionsService) {}

  @Get()
  @RequirePermissions('ai.approve')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListAiActionsQueryDto,
  ) {
    return this.aiActions.list(user.organizationId!, query);
  }

  @Get(':id')
  @RequirePermissions('ai.approve')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.aiActions.getOne(user.organizationId!, id);
  }

  @Patch(':id/approve')
  @RequirePermissions('ai.approve')
  @Audited({ resource: 'ai_action', action: 'approve' })
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.aiActions.approve(user.organizationId!, id, user.id);
  }

  @Patch(':id/reject')
  @RequirePermissions('ai.approve')
  @Audited({ resource: 'ai_action', action: 'reject' })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RejectAiActionDto,
  ) {
    return this.aiActions.reject(user.organizationId!, id, user.id, dto.reason);
  }
}
