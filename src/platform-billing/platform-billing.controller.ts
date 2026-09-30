import { Controller, ForbiddenException, Get, Post } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PlatformBillingService } from './platform-billing.service';

@Controller('platform-billing')
export class PlatformBillingController {
  constructor(private readonly billing: PlatformBillingService) {}

  @Get('plans')
  @RequirePermissions('platform_billing.read')
  plans() {
    return this.billing.plans();
  }

  @Get('subscription')
  @RequirePermissions('platform_billing.read')
  subscription(@CurrentUser() u: AuthenticatedUser) {
    return this.billing.subscription(u.organizationId!);
  }

  /**
   * Gyms cannot change their own plan. This used to switch the caller's
   * organization to any plan on request, with no payment behind it -- the
   * Billing page's "Choose plan" gave any owner the top plan for free.
   * Until self-serve checkout exists, the platform team sets plans through
   * PATCH /platform/organizations/:id/subscription. Kept as an explicit 403
   * rather than removed, so an older client gets a reason instead of a 404.
   */
  @Post('subscription')
  @RequirePermissions('platform_billing.read')
  subscribe(): never {
    throw new ForbiddenException(
      'Plan changes are handled by our team. Contact support to change your plan.',
    );
  }

  @Get('usage')
  @RequirePermissions('platform_billing.read')
  usage(@CurrentUser() u: AuthenticatedUser) {
    return this.billing.usage(u.organizationId!);
  }

  @Get('invoices')
  @RequirePermissions('platform_billing.read')
  invoices(@CurrentUser() u: AuthenticatedUser) {
    return this.billing.invoices(u.organizationId!);
  }
}
