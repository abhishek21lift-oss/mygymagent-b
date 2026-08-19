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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AssignRoleDto } from './dto/assign-role.dto';
import { CreateUserDto } from './dto/create-user.dto';
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
  ) {
    return this.usersService.list(user.organizationId!, query);
  }

  @Get(':id')
  @RequirePermissions('users.read')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.usersService.getOne(user.organizationId!, id);
  }

  @Post()
  @RequirePermissions('users.create')
  @Audited({ resource: 'user', action: 'invite' })
  invite(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateUserDto) {
    return this.usersService.invite(user.organizationId!, dto);
  }

  @Patch(':id')
  @RequirePermissions('users.update')
  @Audited({ resource: 'user', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.usersService.update(user.organizationId!, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('users.delete')
  @Audited({ resource: 'user', action: 'deactivate' })
  deactivate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.usersService.deactivate(user.organizationId!, id);
  }

  @Post(':id/roles')
  @RequirePermissions('users.manage_roles')
  @Audited({ resource: 'user', action: 'assign_role' })
  assignRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AssignRoleDto,
  ) {
    return this.usersService.assignRole(user.organizationId!, id, dto);
  }

  @Delete(':id/roles/:userRoleId')
  @RequirePermissions('users.manage_roles')
  @Audited({ resource: 'user', action: 'revoke_role' })
  revokeRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('userRoleId') userRoleId: string,
  ) {
    return this.usersService.revokeRole(user.organizationId!, id, userRoleId);
  }
}
