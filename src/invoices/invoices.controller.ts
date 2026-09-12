import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { ListInvoicesQueryDto } from './dto/list-invoices-query.dto';
import { VoidInvoiceDto } from './dto/void-invoice.dto';
import { InvoicesService } from './invoices.service';

@Controller('invoices')
@Throttle({ default: { limit: 50, ttl: 60_000 } })
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get()
  @RequirePermissions('payments.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListInvoicesQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.invoicesService.list(user.organizationId!, query, branchScope);
  }

  @Get(':id')
  @RequirePermissions('payments.read')
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.invoicesService.getOne(user.organizationId!, id, branchScope);
  }

  @Post()
  @RequirePermissions('payments.create')
  @Audited({ resource: 'invoice', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateInvoiceDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.invoicesService.create(user.organizationId!, dto, branchScope);
  }

  @Post(':id/void')
  @RequirePermissions('payments.refund')
  @Audited({ resource: 'invoice', action: 'void' })
  void(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() _dto: VoidInvoiceDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.invoicesService.void(user.organizationId!, id, branchScope);
  }

  @Post(':id/retry-collection')
  @RequirePermissions('payments.create')
  @Audited({ resource: 'invoice', action: 'retry-collection' })
  retryCollection(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.invoicesService.retryCollection(
      user.organizationId!,
      id,
      branchScope,
    );
  }
}
