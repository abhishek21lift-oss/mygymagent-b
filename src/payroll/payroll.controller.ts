import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  CreatePayrollPeriodDto,
  GenerateCommissionsDto,
  UpsertCommissionRuleDto,
} from './dto/payroll.dto';
import { PayrollService } from './payroll.service';

@Controller('payroll')
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Get('commission-rules')
  @RequirePermissions('payroll.read')
  rules(@CurrentUser() u: AuthenticatedUser) {
    return this.payroll.rules(u.organizationId!);
  }

  @Post('commission-rules')
  @RequirePermissions('payroll.manage')
  upsertRule(
    @CurrentUser() u: AuthenticatedUser,
    @Body() dto: UpsertCommissionRuleDto,
  ) {
    return this.payroll.upsertRule(u.organizationId!, dto);
  }

  @Patch('commission-rules/:id')
  @RequirePermissions('payroll.manage')
  updateRule(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: Partial<UpsertCommissionRuleDto>,
  ) {
    return this.payroll.updateRule(u.organizationId!, id, dto);
  }

  @Get('commissions')
  @RequirePermissions('payroll.read')
  commissions(
    @CurrentUser() u: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('trainerId') trainerId?: string,
  ) {
    return this.payroll.commissions(u.organizationId!, from, to, trainerId);
  }

  @Post('commissions/generate')
  @RequirePermissions('payroll.manage')
  generate(
    @CurrentUser() u: AuthenticatedUser,
    @Body() dto: GenerateCommissionsDto,
  ) {
    return this.payroll.generateCommissions(u.organizationId!, dto);
  }

  @Get('periods')
  @RequirePermissions('payroll.read')
  periods(@CurrentUser() u: AuthenticatedUser) {
    return this.payroll.periods(u.organizationId!);
  }

  @Post('periods')
  @RequirePermissions('payroll.manage')
  createPeriod(
    @CurrentUser() u: AuthenticatedUser,
    @Body() dto: CreatePayrollPeriodDto,
  ) {
    return this.payroll.createPeriod(u.organizationId!, dto);
  }

  @Post('periods/:id/finalize')
  @RequirePermissions('payroll.manage')
  finalize(@CurrentUser() u: AuthenticatedUser, @Param('id') id: string) {
    return this.payroll.finalize(u.organizationId!, id);
  }

  @Get('summary')
  @RequirePermissions('payroll.read')
  summary(
    @CurrentUser() u: AuthenticatedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.payroll.summary(u.organizationId!, from, to);
  }
}
