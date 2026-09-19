import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireAnyPermission } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  BulkExportDto,
  BulkStatusChangeDto,
  BulkTagAssignmentDto,
} from './dto/member-bulk.dto';
import { MemberBulkService } from './member-bulk.service';

@Controller('members/bulk')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class MemberBulkController {
  constructor(private readonly bulk: MemberBulkService) {}

  @Post('status')
  @RequireAnyPermission('members.update', 'members.update_assigned')
  @Audited({ resource: 'member', action: 'bulk_status_change' })
  changeStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkStatusChangeDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.bulk.changeStatus(
      user.organizationId!,
      dto,
      user.id,
      branchScope,
      assignmentScope,
    );
  }

  @Post('tags')
  @RequireAnyPermission('members.update', 'members.update_assigned')
  @Audited({ resource: 'member_tag_assignment', action: 'bulk_assign' })
  assignTags(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkTagAssignmentDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.bulk.assignTags(
      user.organizationId!,
      dto,
      user.id,
      branchScope,
      assignmentScope,
    );
  }

  @Post('export')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  export(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkExportDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.bulk.export(user.organizationId!, dto, branchScope, assignmentScope);
  }
}
