import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { RefundPaymentDto } from './dto/refund-payment.dto';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get()
  @RequirePermissions('payments.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
    @Query('memberId') memberId?: string,
    @Query('membershipId') membershipId?: string,
  ) {
    return this.paymentsService.list(
      user.organizationId!,
      query,
      memberId,
      membershipId,
    );
  }

  @Get(':id')
  @RequirePermissions('payments.read')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.paymentsService.getOne(user.organizationId!, id);
  }

  @Post()
  @RequirePermissions('payments.create')
  @Audited({ resource: 'payment', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePaymentDto,
  ) {
    return this.paymentsService.create(user.organizationId!, dto, user.id);
  }

  @Post(':id/refund')
  @RequirePermissions('payments.refund')
  @Audited({ resource: 'payment', action: 'refund' })
  refund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RefundPaymentDto,
  ) {
    return this.paymentsService.refund(user.organizationId!, id, dto, user.id);
  }
}
