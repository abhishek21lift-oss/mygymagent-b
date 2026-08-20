import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePlatformRole } from '../common/decorators/require-platform-role.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ListPlatformOrganizationsQueryDto } from './dto/list-platform-organizations-query.dto';
import { UpdateOrganizationStatusDto } from './dto/update-organization-status.dto';
import { PlatformOrganizationsService } from './platform-organizations.service';

/** Cross-tenant organization administration for platform staff only. See
 * PlatformOrganizationsService's class comment for why this is the one
 * deliberate exception to "every service method is organizationId-scoped". */
@Controller('platform/organizations')
@RequirePlatformRole()
export class PlatformOrganizationsController {
  constructor(private readonly service: PlatformOrganizationsService) {}

  @Get()
  list(@Query() query: ListPlatformOrganizationsQueryDto) {
    return this.service.list(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOrganizationStatusDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.service.updateStatus(id, dto, user.id, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      requestId: req.requestId,
    });
  }
}
