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
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ConvertLeadDto } from './dto/convert-lead.dto';
import { CreateFollowUpDto } from './dto/create-follow-up.dto';
import { CreateLeadDto } from './dto/create-lead.dto';
import { ListLeadsQueryDto } from './dto/list-leads-query.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { UpdateLeadStatusDto } from './dto/update-lead-status.dto';
import { LeadsService } from './leads.service';

@Controller('leads')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get()
  @RequirePermissions('leads.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListLeadsQueryDto,
  ) {
    return this.leadsService.list(user.organizationId!, query);
  }

  @Get(':id')
  @RequirePermissions('leads.read')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.leadsService.getOne(user.organizationId!, id);
  }

  @Post()
  @RequirePermissions('leads.manage')
  @Audited({ resource: 'lead', action: 'create' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateLeadDto) {
    return this.leadsService.create(user.organizationId!, dto);
  }

  @Patch(':id')
  @RequirePermissions('leads.manage')
  @Audited({ resource: 'lead', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateLeadDto,
  ) {
    return this.leadsService.update(user.organizationId!, id, dto);
  }

  @Patch(':id/status')
  @RequirePermissions('leads.manage')
  @Audited({ resource: 'lead', action: 'update_status' })
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateLeadStatusDto,
  ) {
    return this.leadsService.updateStatus(user.organizationId!, id, dto);
  }

  @Post(':id/convert')
  @RequirePermissions('leads.manage')
  @Audited({ resource: 'lead', action: 'convert' })
  convert(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ConvertLeadDto,
  ) {
    return this.leadsService.convert(user.organizationId!, id, dto);
  }

  @Post(':id/follow-ups')
  @RequirePermissions('leads.manage')
  @Audited({ resource: 'lead_follow_up', action: 'create' })
  addFollowUp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CreateFollowUpDto,
  ) {
    return this.leadsService.addFollowUp(
      user.organizationId!,
      id,
      dto,
      user.id,
    );
  }

  @Patch(':id/follow-ups/:followUpId/complete')
  @RequirePermissions('leads.manage')
  @Audited({ resource: 'lead_follow_up', action: 'complete' })
  completeFollowUp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('followUpId') followUpId: string,
  ) {
    return this.leadsService.completeFollowUp(
      user.organizationId!,
      id,
      followUpId,
    );
  }
}
