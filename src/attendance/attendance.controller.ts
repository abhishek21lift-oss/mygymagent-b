import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequireAnyPermission } from '../common/decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AttendanceService } from './attendance.service';
import { CheckInDto } from './dto/check-in.dto';
import { ListAttendanceQueryDto } from './dto/list-attendance-query.dto';

@Controller('attendance')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Get()
  @RequireAnyPermission('attendance.read', 'attendance.read_assigned')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListAttendanceQueryDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.attendanceService.list(user.organizationId!, query, {
      branchId: branchScope ?? query.branchId,
      memberId: query.memberId,
      assignmentScope,
    });
  }

  @Post('check-in')
  @RequireAnyPermission('attendance.create', 'attendance.create_assigned')
  @Audited({ resource: 'attendance', action: 'check_in' })
  checkIn(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CheckInDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.attendanceService.checkIn(
      user.organizationId!,
      user.id,
      dto,
      branchScope,
      assignmentScope,
    );
  }

  @Post(':id/check-out')
  @RequireAnyPermission('attendance.create', 'attendance.create_assigned')
  @Audited({ resource: 'attendance', action: 'check_out' })
  checkOut(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.attendanceService.checkOut(
      user.organizationId!,
      id,
      branchScope,
      assignmentScope,
    );
  }
}
