import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  RequireAnyPermission,
} from '../common/decorators/permissions.decorator';
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

  /**
   * Live turnstile view: currently-inside plus today's denied attempts.
   * Declared before `:id` routes would collide -- `live` is a static
   * segment, but explicit ordering keeps routing intent obvious.
   */
  @Get('live')
  @RequireAnyPermission('attendance.read', 'attendance.read_assigned')
  live(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.attendanceService.live(user.organizationId!, branchScope);
  }

  /**
   * QR credential mint. Always (re)generates -- the plaintext `token` is
   * returned once here and never stored (only its hash persists).
   */
  @Get('qr-token/:memberId')
  @RequireAnyPermission(
    'attendance.create',
    'attendance.create_assigned',
    'members.read',
    'members.read_assigned',
  )
  @Audited({ resource: 'member_qr_token', action: 'generate' })
  qrToken(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
  ) {
    return this.attendanceService.getOrRotateQrToken(
      user.organizationId!,
      memberId,
    );
  }

  @Post('check-in')
  @RequireAnyPermission('attendance.create', 'attendance.create_assigned')
  @Audited({ resource: 'attendance', action: 'check_in' })
  async checkIn(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CheckInDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.attendanceService.checkIn(
      user.organizationId!,
      user.id,
      dto,
      branchScope,
      assignmentScope,
    );
    // Turnstile UX needs 200 + decision on denial, not a 4xx; allowed
    // check-ins keep the pre-WS-3 201 so existing callers are unaffected.
    res.status(result.allowed ? HttpStatus.CREATED : HttpStatus.OK);
    return result;
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
