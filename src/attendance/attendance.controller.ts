import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AttendanceService } from './attendance.service';
import { CheckInDto } from './dto/check-in.dto';

@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  @Get()
  @RequirePermissions('attendance.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
    @Query('branchId') branchId?: string,
    @Query('memberId') memberId?: string,
  ) {
    return this.attendanceService.list(user.organizationId!, query, {
      branchId,
      memberId,
    });
  }

  @Post('check-in')
  @RequirePermissions('attendance.create')
  @Audited({ resource: 'attendance', action: 'check_in' })
  checkIn(@CurrentUser() user: AuthenticatedUser, @Body() dto: CheckInDto) {
    return this.attendanceService.checkIn(user.organizationId!, user.id, dto);
  }

  @Post(':id/check-out')
  @RequirePermissions('attendance.create')
  @Audited({ resource: 'attendance', action: 'check_out' })
  checkOut(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.attendanceService.checkOut(user.organizationId!, id);
  }
}
