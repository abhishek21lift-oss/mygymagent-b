import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateMemberDto } from './dto/create-member.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { ListMembersQueryDto } from './dto/list-members-query.dto';
import { BulkStatusChangeDto, BulkExportDto } from './dto/bulk-member.dto';
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
    @Query() query: ListMembersQueryDto,
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
      throw new BadRequestException('memberId query parameter is required');
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
      throw new BadRequestException('memberId query parameter is required');
    }
    const safePage = Math.max(1, parseInt(page ?? '1', 10) || 1);
    const safePageSize = Math.min(
      100,
      Math.max(1, parseInt(pageSize ?? '50', 10) || 50),
    );
    return this.member360Service.getTimeline(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
      safePage,
      safePageSize,
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
      throw new BadRequestException(
        'sourceId and targetId query parameters are required',
      );
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
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.membersService.getMembershipBilling(
      user.organizationId!,
      id,
      branchScope,
      assignmentScope,
    );
  }

  @Post('bulk/status')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('members.update')
  @Audited({ resource: 'member', action: 'bulk_status_change' })
  bulkStatusChange(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkStatusChangeDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.membersService.bulkStatusChange(
      user.organizationId!,
      dto.memberIds,
      dto.status,
      branchScope,
      assignmentScope,
    );
  }

  // NOTE: POST /members/bulk/tags lives in MemberBulkTagsController, NOT
  // here. MembersController registers after MemberTagsController, so any
  // route it declares under :memberId is unreachable shadowed code -- and
  // a duplicate /members/bulk/tags here would be silently shadowed too.
  // See members.module.ts for the ordering constraint.

  @Post('bulk/export')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('members.read')
  async bulkExport(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BulkExportDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    const result = await this.membersService.bulkExport(
      user.organizationId!,
      dto.memberIds,
      branchScope,
      assignmentScope,
    );

    const headers = [
      'Member Code',
      'First Name',
      'Last Name',
      'Email',
      'Phone',
      'Status',
      'Member Type',
      'Branch',
      'Trainer',
      'Joined At',
      'Tags',
    ];

    const escapeCsv = (value: unknown) => {
      const text = value == null ? '' : String(value);
      // Neutralise spreadsheet formula injection: a leading =, +, -, or @
      // (optionally wrapped in quotes) would execute as a formula in
      // Excel/Sheets. Prefixing with a single quote makes it inert text.
      const sanitized = /^[=+\-@]/.test(text) ? `'${text}` : text;
      return /[",\n\r]/.test(sanitized)
        ? `"${sanitized.replace(/"/g, '""')}"`
        : sanitized;
    };

    const csv = [
      headers.join(','),
      ...result.members.map((member) =>
        [
          member.memberCode,
          member.firstName,
          member.lastName,
          member.email,
          member.phone,
          member.status,
          member.memberType,
          member.branch,
          member.trainer,
          member.joinedAt,
          member.tags,
        ]
          .map(escapeCsv)
          .join(','),
      ),
    ].join('\r\n');

    return csv;
  }

  @Delete(':id')
  @RequirePermissions('members.delete')
  @Audited({ resource: 'member', action: 'delete' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.membersService.remove(
      user.organizationId!,
      id,
      branchScope,
      user.id,
    );
  }
}
