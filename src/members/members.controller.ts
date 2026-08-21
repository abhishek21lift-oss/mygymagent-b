import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { RequestedBranchId } from '../common/decorators/branch-id.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateMemberDto } from './dto/create-member.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { MembersService } from './members.service';

@Controller('members')
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  @Get()
  @RequireAnyPermission('members.read', 'members.read_assigned')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
    @RequestedBranchId() requestedBranchId: string | undefined,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.membersService.list(
      user.organizationId!,
      query,
      branchScope ?? requestedBranchId,
      assignmentScope,
    );
  }

  @Get(':id')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.membersService.getOne(
      user.organizationId!,
      id,
      branchScope,
      assignmentScope,
    );
  }

  @Post()
  @RequirePermissions('members.create')
  @Audited({ resource: 'member', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMemberDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membersService.create(
      user.organizationId!,
      dto,
      branchScope,
      user.id,
    );
  }

  @Patch(':id')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateMemberDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membersService.update(
      user.organizationId!,
      id,
      dto,
      branchScope,
      user.id,
    );
  }

  @Get(':id/status-history')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  getStatusHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.membersService.getStatusHistory(
      user.organizationId!,
      id,
      branchScope,
      assignmentScope,
    );
  }

  @Get(':id/branch-history')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  getBranchHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.membersService.getBranchHistory(
      user.organizationId!,
      id,
      branchScope,
      assignmentScope,
    );
  }

  @Get(':id/trainer-history')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  getTrainerHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.membersService.getTrainerHistory(
      user.organizationId!,
      id,
      branchScope,
      assignmentScope,
    );
  }

  @Delete(':id')
  @RequirePermissions('members.delete')
  @Audited({ resource: 'member', action: 'delete' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membersService.remove(user.organizationId!, id, branchScope);
  }
}
