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
import { SetOrganizationPlanDto } from './dto/set-organization-plan.dto';
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

  /**
   * Before `:id`: Nest matches routes in registration order, and `plans`
   * would otherwise be read as an organization id.
   */
  @Get('plans')
  plans() {
    return this.service.plans();
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

  /** The only way a gym's SaaS plan changes today: set by platform staff
   * once the gym has paid (invoiced outside the app during the pilot). */
  @Patch(':id/subscription')
  setPlan(
    @Param('id') id: string,
    @Body() dto: SetOrganizationPlanDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.service.setPlan(id, dto, user.id, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      requestId: req.requestId,
    });
  }
}
