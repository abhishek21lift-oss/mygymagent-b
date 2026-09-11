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
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  AssignMemberTagsDto,
  CreateMemberTagDto,
  UpdateMemberTagDto,
} from './dto/member-tag.dto';
import { MemberTagsService } from './member-tags.service';

@Controller('members/tags')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class MemberTagsController {
  constructor(private readonly tags: MemberTagsService) {}

  @Get()
  @RequireAnyPermission('members.read', 'members.read_assigned')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.tags.list(user.organizationId!);
  }

  @Get(':tagId')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tagId') tagId: string,
  ) {
    return this.tags.getOne(user.organizationId!, tagId);
  }

  @Post()
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_tag', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMemberTagDto,
  ) {
    return this.tags.create(user.organizationId!, dto);
  }

  @Patch(':tagId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_tag', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tagId') tagId: string,
    @Body() dto: UpdateMemberTagDto,
  ) {
    return this.tags.update(user.organizationId!, tagId, dto);
  }

  @Delete(':tagId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_tag', action: 'delete' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tagId') tagId: string,
  ) {
    return this.tags.remove(user.organizationId!, tagId);
  }
}

@Controller('members/:memberId/tags')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class MemberTagAssignmentsController {
  constructor(private readonly tags: MemberTagsService) {}

  @Get()
  @RequireAnyPermission('members.read', 'members.read_assigned')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.tags.listAssignments(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Post()
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_tag_assignment', action: 'assign' })
  assign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Body() dto: AssignMemberTagsDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.tags.assign(
      user.organizationId!,
      memberId,
      dto,
      user.id,
      branchScope,
    );
  }

  @Post(':tagId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_tag_assignment', action: 'assign' })
  addOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('tagId') tagId: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.tags.addOne(
      user.organizationId!,
      memberId,
      tagId,
      user.id,
      branchScope,
    );
  }

  @Delete(':tagId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_tag_assignment', action: 'unassign' })
  removeOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('tagId') tagId: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.tags.removeOne(
      user.organizationId!,
      memberId,
      tagId,
      branchScope,
    );
  }
}
