import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ListPaymentsQueryDto } from './dto/list-payments-query.dto';
import { RefundPaymentDto } from './dto/refund-payment.dto';
import { PaymentsService } from './payments.service';

@Controller('payments')
@Throttle({ default: { limit: 50, ttl: 60_000 } })
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get()
  @RequirePermissions('payments.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListPaymentsQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.paymentsService.list(
      user.organizationId!,
      query,
      query.memberId,
      query.membershipId,
      branchScope,
    );
  }

  @Get(':id')
  @RequirePermissions('payments.read')
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.paymentsService.getOne(user.organizationId!, id, branchScope);
  }

  @Post()
  @RequirePermissions('payments.create')
  @Audited({ resource: 'payment', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePaymentDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.paymentsService.create(
      user.organizationId!,
      dto,
      user.id,
      branchScope,
    );
  }

  @Post(':id/refund')
  @RequirePermissions('payments.refund')
  @Audited({ resource: 'payment', action: 'refund' })
  refund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RefundPaymentDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.paymentsService.refund(
      user.organizationId!,
      id,
      dto,
      user.id,
      branchScope,
    );
  }
}
