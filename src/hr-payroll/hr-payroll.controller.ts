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
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  CreateLeaveRequestDto,
  CreateLeaveTypeDto,
  CreatePayrollRunDto,
  ListStaffPayrollQueryDto,
  PayrollItemAdjustmentDto,
  ReviewLeaveDto,
  UpdateStaffPayrollDto,
} from './dto/hr-payroll.dto';
import { HrPayrollService } from './hr-payroll.service';

@Controller('hr-payroll')
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class HrPayrollController {
  constructor(private readonly hr: HrPayrollService) {}

  /**
   * Staff payroll terms (B-P1-7). `processPayrollRun` reads
   * `payrollEnabled`, `salaryType`, `baseSalary` and `hourlyRate`, and
   * nothing in the API wrote any of them -- so a payroll run on a real
   * deployment either found no enabled staff or computed from nulls.
   *
   * Gated on `hr.*` rather than `users.update`, deliberately. The
   * permission catalog already describes `hr.read` as covering "payroll
   * settings", the fields live on `StaffProfile` beside leave and hire
   * date, and `hr.manage` includes BRANCH_MANAGER -- the role that
   * actually runs HR for a branch, and which `users.update` excludes.
   * Putting salaries behind a general staff-record permission would have
   * been both a worse semantic fit and the wrong set of people.
   */
  @Get('staff')
  @RequirePermissions('hr.read')
  listStaffPayroll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListStaffPayrollQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.hr.listStaffPayroll(user.organizationId!, query, branchScope);
  }

  @Patch('staff/:userId')
  @RequirePermissions('hr.manage')
  @Audited({ resource: 'staff_payroll', action: 'update' })
  updateStaffPayroll(
    @CurrentUser() user: AuthenticatedUser,
    @Param('userId') userId: string,
    @Body() dto: UpdateStaffPayrollDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.hr.updateStaffPayroll(
      user.organizationId!,
      userId,
      dto,
      branchScope,
    );
  }

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
