import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
  CreateMemberTagDto,
  UpdateMemberTagDto,
  AssignMemberTagsDto,
} from './dto/member-tag.dto';
import { MemberTagsService } from './member-tags.service';

@Controller('members')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class MemberTagsController {
  constructor(private readonly tags: MemberTagsService) {}

  // --- Tag management (org-scoped) ---

  @Get('tags')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  listTags(@CurrentUser() user: AuthenticatedUser) {
    return this.tags.listTags(user.organizationId!);
  }

  @Get('tags/:tagId')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  getTag(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tagId') tagId: string,
  ) {
    return this.tags.getTag(user.organizationId!, tagId);
  }

  @Post('tags')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_tag', action: 'create' })
  createTag(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMemberTagDto,
  ) {
    return this.tags.createTag(user.organizationId!, dto, user.id);
  }

  @Patch('tags/:tagId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_tag', action: 'update' })
  updateTag(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tagId') tagId: string,
    @Body() dto: UpdateMemberTagDto,
  ) {
    return this.tags.updateTag(user.organizationId!, tagId, dto);
  }

  @Delete('tags/:tagId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_tag', action: 'delete' })
  deleteTag(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tagId') tagId: string,
  ) {
    return this.tags.deleteTag(user.organizationId!, tagId);
  }

  // --- Tag assignments (member-scoped) ---

  @Get(':memberId/tags')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  getMemberTags(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.tags.getMemberTags(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Post(':memberId/tags')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_tag_assignment', action: 'assign' })
  assignTags(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Body() dto: AssignMemberTagsDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.tags.assignTags(
      user.organizationId!,
      memberId,
      dto,
      user.id,
      branchScope,
      assignmentScope,
    );
  }

  @Post(':memberId/tags/:tagId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_tag_assignment', action: 'add' })
  addTagToMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('tagId') tagId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.tags.addTagToMember(
      user.organizationId!,
      memberId,
      tagId,
      user.id,
      branchScope,
      assignmentScope,
    );
  }

  @Delete(':memberId/tags/:tagId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_tag_assignment', action: 'remove' })
  removeTagFromMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('tagId') tagId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.tags.removeTagFromMember(
      user.organizationId!,
      memberId,
      tagId,
      branchScope,
      assignmentScope,
    );
  }
}
