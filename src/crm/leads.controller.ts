import {
  Body,
  Controller,
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
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ConvertLeadDto } from './dto/convert-lead.dto';
import { CreateFollowUpDto } from './dto/create-follow-up.dto';
import { CreateLeadDto } from './dto/create-lead.dto';
import { ListLeadsQueryDto } from './dto/list-leads-query.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { UpdateLeadStatusDto } from './dto/update-lead-status.dto';
import { LeadsService } from './leads.service';

@Controller('leads')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get()
  @RequirePermissions('leads.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListLeadsQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.leadsService.list(user.organizationId!, query, branchScope);
  }

  @Get(':id')
  @RequirePermissions('leads.read')
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.leadsService.getOne(user.organizationId!, id, branchScope);
  }

  @Post()
  @RequirePermissions('leads.manage')
  @Audited({ resource: 'lead', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateLeadDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.leadsService.create(user.organizationId!, dto, branchScope);
  }

  @Patch(':id')
  @RequirePermissions('leads.manage')
  @Audited({ resource: 'lead', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateLeadDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.leadsService.update(user.organizationId!, id, dto, branchScope);
  }

  @Patch(':id/status')
  @RequirePermissions('leads.manage')
  @Audited({ resource: 'lead', action: 'update_status' })
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateLeadStatusDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.leadsService.updateStatus(
      user.organizationId!,
      id,
      dto,
      branchScope,
    );
  }

  @Post(':id/convert')
  @RequirePermissions('leads.manage')
  @Audited({ resource: 'lead', action: 'convert' })
  convert(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ConvertLeadDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.leadsService.convert(
      user.organizationId!,
      id,
      dto,
      branchScope,
    );
  }

  @Post(':id/follow-ups')
  @RequirePermissions('leads.manage')
  @Audited({ resource: 'lead_follow_up', action: 'create' })
  addFollowUp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateFollowUpDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.leadsService.addFollowUp(
      user.organizationId!,
      id,
      dto,
      user.id,
      branchScope,
    );
  }

  @Patch(':id/follow-ups/:followUpId/complete')
  @RequirePermissions('leads.manage')
  @Audited({ resource: 'lead_follow_up', action: 'complete' })
  completeFollowUp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('followUpId') followUpId: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.leadsService.completeFollowUp(
      user.organizationId!,
      id,
      followUpId,
      branchScope,
    );
  }
}
