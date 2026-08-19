import { Body, Controller, Get, Patch } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationsService } from './organizations.service';

@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get('current')
  @RequirePermissions('organizations.read')
  getCurrent(@CurrentUser() user: AuthenticatedUser) {
    return this.organizationsService.getCurrent(user.organizationId!);
  }

  @Patch('current')
  @RequirePermissions('organizations.update')
  @Audited({ resource: 'organization', action: 'update' })
  updateCurrent(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.organizationsService.updateCurrent(user.organizationId!, dto);
  }
}
