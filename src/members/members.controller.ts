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
import { RequestedBranchId } from '../common/decorators/branch-id.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateMemberDto } from './dto/create-member.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { MembersService } from './members.service';

@Controller('members')
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  @Get()
  @RequirePermissions('members.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
    @RequestedBranchId() branchId?: string,
  ) {
    return this.membersService.list(user.organizationId!, query, branchId);
  }

  @Get(':id')
  @RequirePermissions('members.read')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.membersService.getOne(user.organizationId!, id);
  }

  @Post()
  @RequirePermissions('members.create')
  @Audited({ resource: 'member', action: 'create' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateMemberDto) {
    return this.membersService.create(user.organizationId!, dto);
  }

  @Patch(':id')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateMemberDto,
  ) {
    return this.membersService.update(user.organizationId!, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('members.delete')
  @Audited({ resource: 'member', action: 'delete' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.membersService.remove(user.organizationId!, id);
  }
}
