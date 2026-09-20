import { Body, Controller, Get, Post } from '@nestjs/common';
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

  @Post('subscription')
  @RequirePermissions('platform_billing.manage')
  subscribe(
    @CurrentUser() u: AuthenticatedUser,
    @Body() body: { planKey: string },
  ) {
    return this.billing.subscribe(u.organizationId!, body.planKey);
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
