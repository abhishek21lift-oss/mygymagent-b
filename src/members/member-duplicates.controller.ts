import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ExecuteMergeDto } from './dto/member-merge.dto';
import { MemberDuplicatesService } from './member-duplicates.service';

/// Duplicate detection and supervised merge. Detection proposes scored
/// candidates; merging always requires an explicit per-field resolution
/// and soft-deletes (never destroys) the source record.
@Controller('members')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class MemberDuplicatesController {
  constructor(private readonly duplicates: MemberDuplicatesService) {}

  @Get('duplicates/preview-merge')
  @RequirePermissions('members.update')
  previewMerge(
    @CurrentUser() user: AuthenticatedUser,
    @Query('sourceId') sourceId: string,
    @Query('targetId') targetId: string,
  ) {
    return this.duplicates.previewMerge(
      user.organizationId!,
      sourceId,
      targetId,
    );
  }

  @Post('duplicates/execute-merge')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member', action: 'merge' })
  executeMerge(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ExecuteMergeDto,
  ) {
    return this.duplicates.executeMerge(user.organizationId!, dto, user.id);
  }

  @Get(':memberId/duplicates')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  findDuplicates(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.duplicates.findDuplicates(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }
}
