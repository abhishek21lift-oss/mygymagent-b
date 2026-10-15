import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PtPackagesService } from './pt-packages.service';
import { CreatePtPackageDto } from './dto/create-pt-package.dto';

@Controller('pt-packages')
export class PtPackagesController {
  constructor(private readonly service: PtPackagesService) {}

  @Get()
  // A trainer holds only `pt-packages.read_assigned`: they read packages
  // belonging to their assigned clients, never the whole book.
  @RequireAnyPermission('pt-packages.read', 'pt-packages.read_assigned')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('memberId') memberId?: string,
    @CurrentBranchScope() branchScope: string | null = null,
    @CurrentAssignmentScope() assignmentScope: string | null = null,
  ) {
    return this.service.list(
      user.organizationId ?? '',
      memberId ?? undefined,
      branchScope,
      assignmentScope,
    );
  }

  @Get(':id')
  @RequireAnyPermission('pt-packages.read', 'pt-packages.read_assigned')
  getOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null = null,
    @CurrentAssignmentScope() assignmentScope: string | null = null,
  ) {
    return this.service.getOne(
      user.organizationId ?? '',
      id,
      branchScope,
      assignmentScope,
    );
  }

  @Get(':id/wallet')
  @RequireAnyPermission('pt-packages.read', 'pt-packages.read_assigned')
  getWallet(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null = null,
    @CurrentAssignmentScope() assignmentScope: string | null = null,
  ) {
    return this.service.getWallet(
      user.organizationId ?? '',
      id,
      branchScope,
      assignmentScope,
    );
  }

  @Post()
  @RequirePermissions('pt-packages.create')
  create(
    @Body() dto: CreatePtPackageDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null = null,
  ) {
    return this.service.create(
      user.organizationId ?? '',
      dto,
      user.id,
      branchScope,
    );
  }
}
