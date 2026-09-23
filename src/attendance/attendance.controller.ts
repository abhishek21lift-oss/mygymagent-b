import {
  Body,
  Controller,
  Delete,
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
import { RequireAnyPermission } from '../common/decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AttendanceService } from './attendance.service';
import { CheckInDto } from './dto/check-in.dto';
import {
  CreateDeviceEnrolmentDto,
  ListDeviceEnrolmentsQueryDto,
} from './dto/device-enrolment.dto';
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
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.attendanceService.live(
      user.organizationId!,
      branchScope,
      assignmentScope,
    );
  }

  /**
   * QR credential mint. Always (re)generates -- the plaintext `token` is
   * returned once here and never stored (only its hash persists).
   *
   * Gated on `attendance.create*` only, deliberately matching `check-in`
   * below (B-P0-9). It used to also accept `members.read*`, which made
   * minting a durable entry credential a *lower* bar than recording a
   * single check-in with it -- exactly backwards. Reading a member's
   * profile and issuing physical access to the building are different
   * privileges and no longer share one.
   *
   * Narrowing this removes the route from NUTRITIONIST, SALES_EXECUTIVE
   * and ACCOUNTANT, none of whom work the door; every front-desk and
   * training role (RECEPTIONIST, TRAINER, HEAD_TRAINER, BRANCH_MANAGER,
   * STAFF, and the org/platform roles) holds `attendance.create*` and is
   * unaffected.
   */
  @Get('qr-token/:memberId')
  @RequireAnyPermission('attendance.create', 'attendance.create_assigned')
  @Audited({ resource: 'member_qr_token', action: 'generate' })
  qrToken(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.attendanceService.getOrRotateQrToken(
      user.organizationId!,
      memberId,
      assignmentScope,
    );
  }

  /**
   * Turnstile enrolment: which member a scanner's own user id belongs to
   * (B-P1-8). Until this existed, `DeviceMap` had no writer and every
   * biometric check-in answered "unenrolled device user".
   *
   * Gated on `attendance.create*`, not `kiosk.manage`, and the split is
   * deliberate: `kiosk.manage` administers the *hardware* (register and
   * revoke a device, B-P0-13), which is branch-manager work, while this
   * decides who may walk through the door -- the same privilege as
   * minting a QR credential, which B-P0-9 settled at `attendance.create*`
   * so the front desk and trainers can do their job. Assignment scope
   * applies for the same reason it does there.
   *
   * Declared before `:id/check-out` so `enrolments` is never read as an
   * attendance id.
   */
  @Post('enrolments')
  @RequireAnyPermission('attendance.create', 'attendance.create_assigned')
  @Audited({ resource: 'device_enrolment', action: 'create' })
  createEnrolment(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateDeviceEnrolmentDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.attendanceService.createEnrolment(
      user.organizationId!,
      dto,
      branchScope,
      assignmentScope,
    );
  }

  @Get('enrolments')
  @RequireAnyPermission('attendance.read', 'attendance.read_assigned')
  listEnrolments(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListDeviceEnrolmentsQueryDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.attendanceService.listEnrolments(
      user.organizationId!,
      query,
      branchScope,
      assignmentScope,
    );
  }

  @Delete('enrolments/:id')
  @RequireAnyPermission('attendance.create', 'attendance.create_assigned')
  @Audited({ resource: 'device_enrolment', action: 'delete' })
  deleteEnrolment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.attendanceService.deleteEnrolment(
      user.organizationId!,
      id,
      branchScope,
      assignmentScope,
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
