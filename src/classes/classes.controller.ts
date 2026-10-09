import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ClassesService } from './classes.service';
import {
  BookClassDto,
  ClassAttendanceDto,
  CreateClassProgramDto,
  CreateClassSessionDto,
  ListClassSessionsDto,
  ListClassesDto,
} from './dto/classes.dto';

@Controller('classes')
export class ClassesController {
  constructor(private readonly classes: ClassesService) {}
  @Get('programs')
  @RequirePermissions('classes.read')
  programs(
    @CurrentUser() u: AuthenticatedUser,
    @Query() q: ListClassesDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.classes.programs(u.organizationId!, q, branchScope);
  }
  @Post('programs')
  @RequirePermissions('classes.manage')
  createProgram(
    @CurrentUser() u: AuthenticatedUser,
    @Body() dto: CreateClassProgramDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.classes.createProgram(u.organizationId!, dto, branchScope);
  }
  @Get('sessions')
  @RequirePermissions('classes.read')
  sessions(
    @CurrentUser() u: AuthenticatedUser,
    @Query() q: ListClassSessionsDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.classes.sessions(u.organizationId!, q, branchScope);
  }
  @Post('sessions')
  @RequirePermissions('classes.manage')
  createSession(
    @CurrentUser() u: AuthenticatedUser,
    @Body() dto: CreateClassSessionDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.classes.createSession(u.organizationId!, dto, branchScope);
  }
  @Post('sessions/:id/book')
  @RequirePermissions('classes.book')
  book(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: BookClassDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.classes.book(u.organizationId!, id, dto.memberId, branchScope);
  }
  @Get('sessions/:id/bookings')
  @RequirePermissions('classes.read')
  sessionBookings(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.classes.sessionBookings(u.organizationId!, id, branchScope);
  }
  @Patch('bookings/:id/cancel')
  @RequirePermissions('classes.book')
  cancel(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.classes.cancel(u.organizationId!, id, branchScope);
  }
  @Patch('bookings/:id/attendance')
  @RequirePermissions('classes.attendance')
  attendance(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ClassAttendanceDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.classes.attendance(
      u.organizationId!,
      id,
      dto.status,
      branchScope,
    );
  }
  @Get('analytics')
  @RequirePermissions('classes.read')
  analytics(
    @CurrentUser() u: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
  ) {
    // A branch-scoped caller's own branch wins over any requested one.
    return this.classes.analytics(
      u.organizationId!,
      from,
      to,
      branchScope ?? branchId,
    );
  }
}
