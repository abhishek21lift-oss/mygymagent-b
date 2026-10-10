import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ActionCenterService } from './action-center.service';
import {
  DayQueryDto,
  UpdateActionCenterSettingsDto,
} from './dto/action-center.dto';
import {
  ApproveProposalDto,
  ListProposalsQueryDto,
  RejectProposalDto,
} from './dto/proposals.dto';
import { ProposalsService } from './proposals.service';
import { TaskGeneratorService } from './task-generator.service';

@Controller('action-center')
@Throttle({ default: { limit: 120, ttl: 60_000 } })
export class ActionCenterController {
  constructor(
    private readonly center: ActionCenterService,
    private readonly proposals: ProposalsService,
    private readonly generator: TaskGeneratorService,
  ) {}

  @Get('summary')
  @RequirePermissions('tasks.read')
  summary(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Query() query: DayQueryDto,
  ) {
    return this.center.summary(user, branchScope, query);
  }

  @Get('queue')
  @RequirePermissions('tasks.read')
  queue(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Query() query: DayQueryDto,
  ) {
    return this.center.queue(user, branchScope, query);
  }

  @Get('briefing')
  @RequirePermissions('tasks.read')
  briefing(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Query() query: DayQueryDto,
  ) {
    return this.center.briefing(user, branchScope, query);
  }

  @Get('report')
  @RequirePermissions('tasks.read')
  report(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Query() query: DayQueryDto,
  ) {
    return this.center.report(user, branchScope, query);
  }

  @Get('proposals')
  @RequirePermissions('tasks.read')
  listProposals(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Query() query: ListProposalsQueryDto,
  ) {
    return this.proposals.list(user, branchScope, query);
  }

  @Post('proposals/:id/approve')
  @RequirePermissions('tasks.work')
  @Audited({ resource: 'action_proposal', action: 'approve' })
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveProposalDto,
  ) {
    return this.proposals.approve(user, branchScope, id, dto);
  }

  @Post('proposals/:id/reject')
  @RequirePermissions('tasks.work')
  @Audited({ resource: 'action_proposal', action: 'reject' })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectProposalDto,
  ) {
    return this.proposals.reject(user, branchScope, id, dto.reason);
  }

  /** Build today's generated tasks now instead of waiting for the hourly run. */
  @Post('generate')
  @RequirePermissions('tasks.manage')
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  generate(@CurrentUser() user: AuthenticatedUser) {
    return this.generator.run(user.organizationId!);
  }

  @Get('settings')
  @RequirePermissions('tasks.read')
  getSettings(@CurrentUser() user: AuthenticatedUser) {
    return this.center.getSettings(user.organizationId!);
  }

  @Patch('settings')
  @RequirePermissions('tasks.manage')
  @Audited({ resource: 'action_center_settings', action: 'update' })
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateActionCenterSettingsDto,
  ) {
    return this.center.updateSettings(user.organizationId!, dto);
  }
}
