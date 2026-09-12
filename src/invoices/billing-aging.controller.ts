import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { InvoicesService } from './invoices.service';

/**
 * Receivable aging under the /billing namespace (no BillingController
 * exists -- payments live under /payments -- so this small controller
 * owns the /billing prefix for invoice reporting without touching the
 * billing module).
 */
@Controller('billing')
@Throttle({ default: { limit: 50, ttl: 60_000 } })
export class BillingAgingController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get('aging')
  @RequirePermissions('payments.read')
  getAging(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.invoicesService.getAging(user.organizationId!, branchScope);
  }
}
