import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { RolesService } from './roles.service';

/**
 * The read side of `roles.read`.
 *
 * POST /users/:id/roles takes a `roleKey` and nothing ever listed one, so
 * assigning a role meant knowing a key by heart. This is the list that
 * makes that endpoint usable, and the only thing `roles.read` has ever
 * been meant to cover.
 */
@Controller('roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  @RequirePermissions('roles.read')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.roles.listAssignable(user.organizationId!);
  }

  @Get('permissions')
  @RequirePermissions('roles.read')
  permissions() {
    return this.roles.permissionCatalog();
  }
}
