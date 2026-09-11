import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
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
  @RequirePermissions('members.update')
  @Audited({ resource: 'member', action: 'bulk_status_change' })
  changeStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkStatusChangeDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.bulk.changeStatus(
      user.organizationId!,
      dto,
      user.id,
      branchScope,
    );
  }

  @Post('tags')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_tag_assignment', action: 'bulk_assign' })
  assignTags(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkTagAssignmentDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.bulk.assignTags(
      user.organizationId!,
      dto,
      user.id,
      branchScope,
    );
  }

  @Post('export')
  @RequirePermissions('members.read')
  export(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkExportDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.bulk.export(user.organizationId!, dto, branchScope);
  }
}
