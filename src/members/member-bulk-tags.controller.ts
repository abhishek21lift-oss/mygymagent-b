import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { BulkTagAssignmentDto } from './dto/bulk-member.dto';
import { MembersService } from './members.service';

@Controller('members')
export class MemberBulkTagsController {
  constructor(private readonly membersService: MembersService) {}

  @Post('bulk/tags')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('members.update')
  @Audited({ resource: 'member', action: 'bulk_tag_assignment' })
  bulkTagAssignment(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkTagAssignmentDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.membersService.bulkTagAssignment(
      user.organizationId!,
      dto.memberIds,
      dto.tagIds,
      branchScope,
      assignmentScope,
    );
  }
}
