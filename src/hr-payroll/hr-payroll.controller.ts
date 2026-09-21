import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  CreateLeaveRequestDto,
  CreateLeaveTypeDto,
  CreatePayrollRunDto,
  PayrollItemAdjustmentDto,
  ReviewLeaveDto,
} from './dto/hr-payroll.dto';
import { HrPayrollService } from './hr-payroll.service';

@Controller('hr-payroll')
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class HrPayrollController {
  constructor(private readonly hr: HrPayrollService) {}

  @Get('leave-types')
  @RequirePermissions('hr.read')
  leaveTypes(@CurrentUser() user: AuthenticatedUser) {
    return this.hr.leaveTypes(user.organizationId!);
  }

  @Post('leave-types')
  @RequirePermissions('hr.manage')
  @Audited({ resource: 'leave_type', action: 'create' })
  createLeaveType(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateLeaveTypeDto,
  ) {
    return this.hr.createLeaveType(user.organizationId!, dto);
  }

  @Get('leave-requests')
  @RequirePermissions('hr.read')
  leaveRequests(
    @CurrentUser() user: AuthenticatedUser,
    @Query('status') status?: string,
  ) {
    return this.hr.leaveRequests(user.organizationId!, status);
  }

  @Post('leave-requests')
  @RequirePermissions('hr.manage')
  @Audited({ resource: 'leave_request', action: 'create' })
  createLeaveRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateLeaveRequestDto,
  ) {
    return this.hr.createLeaveRequest(user.organizationId!, dto);
  }

  @Patch('leave-requests/:id/review')
  @RequirePermissions('hr.manage')
  @Audited({ resource: 'leave_request', action: 'review' })
  reviewLeave(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReviewLeaveDto,
  ) {
    return this.hr.reviewLeave(user.organizationId!, id, dto, user.id);
  }

  @Get('payroll-runs')
  @RequirePermissions('payroll.read')
  payrollRuns(@CurrentUser() user: AuthenticatedUser) {
    return this.hr.listPayrollRuns(user.organizationId!);
  }

  @Post('payroll-runs')
  @RequirePermissions('payroll.manage')
  @Audited({ resource: 'payroll_run', action: 'create' })
  createPayrollRun(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePayrollRunDto,
  ) {
    return this.hr.createPayrollRun(user.organizationId!, user.id, dto);
  }

  @Patch('payroll-runs/:id/items')
  @RequirePermissions('payroll.manage')
  @Audited({ resource: 'payroll_item', action: 'adjust' })
  adjustItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: PayrollItemAdjustmentDto,
  ) {
    return this.hr.adjustPayrollItem(user.organizationId!, id, dto);
  }

  @Post('payroll-runs/:id/approve')
  @RequirePermissions('payroll.manage')
  @Audited({ resource: 'payroll_run', action: 'approve' })
  approve(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.hr.approvePayrollRun(user.organizationId!, id, user.id);
  }

  @Post('payroll-runs/:id/process')
  @RequirePermissions('payroll.manage')
  @Audited({ resource: 'payroll_run', action: 'process' })
  process(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.hr.processPayrollRun(user.organizationId!, id);
  }
}
