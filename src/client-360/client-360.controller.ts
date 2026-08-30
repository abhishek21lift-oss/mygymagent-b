import { Controller, Get, Param } from '@nestjs/common';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireAnyPermission } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { Client360Service } from './client-360.service';

@Controller('client-360')
export class Client360Controller {
  constructor(private readonly client360: Client360Service) {}

  @Get(':memberId')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  getClient360(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.client360.getClient360(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }
}
