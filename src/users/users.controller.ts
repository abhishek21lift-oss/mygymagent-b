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
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AssignRoleDto } from './dto/assign-role.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { GrantAccessDto } from './dto/grant-access.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @RequirePermissions('users.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.usersService.list(user.organizationId!, query, branchScope);
  }

  @Get('stats')
  @RequirePermissions('users.read')
  stats(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.usersService.stats(user.organizationId!, branchScope);
  }

  @Get(':id')
  @RequirePermissions('users.read')
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.usersService.getOne(user.organizationId!, id, branchScope);
  }

  @Post()
  @RequirePermissions('users.create')
  @Audited({ resource: 'user', action: 'invite' })
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateUserDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.usersService.invite(
      user.organizationId!,
      dto,
      branchScope,
      user.id,
    );
  }

  @Patch(':id')
  @RequirePermissions('users.update')
  @Audited({ resource: 'user', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.usersService.update(
      user.organizationId!,
      id,
      dto,
      branchScope,
      user.id,
    );
  }

  @Delete(':id')
  @RequirePermissions('users.delete')
  @Audited({ resource: 'user', action: 'deactivate' })
  deactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.usersService.deactivate(
      user.organizationId!,
      id,
      branchScope,
      user.id,
    );
  }

  @Post(':id/invite')
  @RequirePermissions('users.create')
  @Audited({ resource: 'user', action: 'grant_access' })
  grantAccess(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: GrantAccessDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.usersService.grantAccess(
      user.organizationId!,
      id,
      dto,
      branchScope,
      user.id,
    );
  }

  @Post(':id/roles')
  @RequirePermissions('users.manage_roles')
  @Audited({ resource: 'user', action: 'assign_role' })
  assignRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AssignRoleDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.usersService.assignRole(
      user.organizationId!,
      id,
      dto,
      branchScope,
      user.id,
    );
  }

  @Delete(':id/roles/:userRoleId')
  @RequirePermissions('users.manage_roles')
  @Audited({ resource: 'user', action: 'revoke_role' })
  revokeRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('userRoleId') userRoleId: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.usersService.revokeRole(
      user.organizationId!,
      id,
      userRoleId,
      branchScope,
      user.id,
    );
  }
}
