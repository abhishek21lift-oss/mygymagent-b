import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CancelMembershipDto } from './dto/cancel-membership.dto';
import { CreateMembershipDto } from './dto/create-membership.dto';
import { FreezeMembershipDto } from './dto/freeze-membership.dto';
import { ListMembershipsQueryDto } from './dto/list-memberships-query.dto';
import { MembershipsService } from './memberships.service';

@Controller('memberships')
export class MembershipsController {
  constructor(private readonly membershipsService: MembershipsService) {}

  @Get()
  @RequirePermissions('memberships.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListMembershipsQueryDto,
  ) {
    return this.membershipsService.list(
      user.organizationId!,
      query,
      query.memberId,
    );
  }

  @Get(':id')
  @RequirePermissions('memberships.read')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.membershipsService.getOne(user.organizationId!, id);
  }

  @Post()
  @RequirePermissions('memberships.create')
  @Audited({ resource: 'membership', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateMembershipDto,
  ) {
    return this.membershipsService.create(user.organizationId!, dto);
  }

  @Post(':id/freeze')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'freeze' })
  freeze(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: FreezeMembershipDto,
  ) {
    return this.membershipsService.freeze(user.organizationId!, id, dto);
  }

  @Post(':id/resume')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'resume' })
  resume(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.membershipsService.resume(user.organizationId!, id);
  }

  @Post(':id/cancel')
  @RequirePermissions('memberships.update')
  @Audited({ resource: 'membership', action: 'cancel' })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CancelMembershipDto,
  ) {
    return this.membershipsService.cancel(user.organizationId!, id, dto);
  }
}
