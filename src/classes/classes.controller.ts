import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ClassesService } from './classes.service';
import { BookClassDto, ClassAttendanceDto, CreateClassProgramDto, CreateClassSessionDto, ListClassSessionsDto, ListClassesDto } from './dto/classes.dto';

@Controller('classes')
export class ClassesController {
  constructor(private readonly classes: ClassesService) {}
  @Get('programs') @RequirePermissions('classes.read')
  programs(@CurrentUser() u: AuthenticatedUser, @Query() q: ListClassesDto) { return this.classes.programs(u.organizationId!, q); }
  @Post('programs') @RequirePermissions('classes.manage')
  createProgram(@CurrentUser() u: AuthenticatedUser, @Body() dto: CreateClassProgramDto) { return this.classes.createProgram(u.organizationId!, dto); }
  @Get('sessions') @RequirePermissions('classes.read')
  sessions(@CurrentUser() u: AuthenticatedUser, @Query() q: ListClassSessionsDto) { return this.classes.sessions(u.organizationId!, q); }
  @Post('sessions') @RequirePermissions('classes.manage')
  createSession(@CurrentUser() u: AuthenticatedUser, @Body() dto: CreateClassSessionDto) { return this.classes.createSession(u.organizationId!, dto); }
  @Post('sessions/:id/book') @RequirePermissions('classes.book')
  book(@CurrentUser() u: AuthenticatedUser, @Param('id') id: string, @Body() dto: BookClassDto) { return this.classes.book(u.organizationId!, id, dto.memberId); }
  @Patch('bookings/:id/cancel') @RequirePermissions('classes.book')
  cancel(@CurrentUser() u: AuthenticatedUser, @Param('id') id: string) { return this.classes.cancel(u.organizationId!, id); }
  @Patch('bookings/:id/attendance') @RequirePermissions('classes.attendance')
  attendance(@CurrentUser() u: AuthenticatedUser, @Param('id') id: string, @Body() dto: ClassAttendanceDto) { return this.classes.attendance(u.organizationId!, id, dto.status); }
  @Get('analytics') @RequirePermissions('classes.read')
  analytics(@CurrentUser() u: AuthenticatedUser, @Query('from') from?: string, @Query('to') to?: string, @Query('branchId') branchId?: string) { return this.classes.analytics(u.organizationId!, from, to, branchId); }
}