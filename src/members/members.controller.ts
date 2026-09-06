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
import { Throttle } from '@nestjs/throttler';
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
import { Member360Service } from './member-360.service';
import { MemberDuplicateService } from './member-duplicate.service';

@Controller('members')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class MembersController {
  constructor(
    private readonly membersService: MembersService,
    private readonly member360Service: Member360Service,
    private readonly duplicateService: MemberDuplicateService,
  ) {}

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

  @Get('overview')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  getOverview(
    @CurrentUser() user: AuthenticatedUser,
    @Query('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    if (!memberId) {
      throw new Error('memberId query parameter is required');
    }
    return this.member360Service.getOverview(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Get('timeline')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  getTimeline(
    @CurrentUser() user: AuthenticatedUser,
    @Query('memberId') memberId: string,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    if (!memberId) {
      throw new Error('memberId query parameter is required');
    }
    return this.member360Service.getTimeline(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
      page ? parseInt(page, 10) : 1,
      pageSize ? parseInt(pageSize, 10) : 50,
    );
  }

  @Get('duplicates')
  @RequirePermissions('members.read')
  findAllDuplicates(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.duplicateService.findAllDuplicates(
      user.organizationId!,
      branchScope,
      assignmentScope,
    );
  }

  @Get('duplicates/preview-merge')
  @RequirePermissions('members.read')
  previewMerge(
    @CurrentUser() user: AuthenticatedUser,
    @Query('sourceId') sourceId: string,
    @Query('targetId') targetId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    if (!sourceId || !targetId) {
      throw new Error('sourceId and targetId query parameters are required');
    }
    return this.duplicateService.previewMerge(
      user.organizationId!,
      sourceId,
      targetId,
      branchScope,
      assignmentScope,
    );
  }

  @Post('duplicates/execute-merge')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_merge', action: 'execute' })
  executeMerge(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body: {
      sourceMemberId: string;
      targetMemberId: string;
      resolution: Record<string, 'source' | 'target'>;
    },
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.duplicateService.executeMerge(
      user.organizationId!,
      body.sourceMemberId,
      body.targetMemberId,
      user.id,
      body.resolution,
      branchScope,
      assignmentScope,
    );
  }

  @Get(':id/duplicates')
  @RequirePermissions('members.read')
  findMemberDuplicates(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.duplicateService.findDuplicates(
      user.organizationId!,
      id,
      branchScope,
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
      dto.emergencyContactRelationship,
      dto.waiverConsent,
      dto.fitnessGoal,
      dto.injuries,
      dto.allergies,
      dto.medicalNotes,
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

  @Get(':id/membership-billing')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  getMembershipBilling(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membersService.getMembershipBilling(
      user.organizationId!,
      id,
      branchScope,
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
