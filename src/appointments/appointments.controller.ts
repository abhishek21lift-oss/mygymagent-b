import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AppointmentsService } from './appointments.service';
import {
  AddTimeOffDto,
  CalendarQueryDto,
  CancelAppointmentDto,
  CreateAppointmentDto,
  ListAppointmentsQueryDto,
  RescheduleAppointmentDto,
  SetAvailabilityRuleDto,
  UpdateAppointmentDto,
} from './dto/appointment.dto';

/// NOTE on route registration order: static sub-paths (`calendar`,
/// `availability`, `time-off`, `free-slots`) are declared before
/// `:id` so Express never matches them as an appointment id.
@Controller('appointments')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get('calendar')
  @RequireAnyPermission('appointments.read', 'appointments.read_assigned')
  calendar(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: CalendarQueryDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.appointments.calendarFeed(
      user.organizationId!,
      query,
      branchScope,
      assignmentScope,
    );
  }

  @Get('availability')
  @RequireAnyPermission('appointments.read', 'appointments.read_assigned')
  listAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Query('staffId') staffId?: string,
  ) {
    return this.appointments.listAvailabilityRules(
      user.organizationId!,
      staffId,
    );
  }

  @Post('availability')
  @RequirePermissions('appointments.manage_availability')
  @Audited({ resource: 'appointment_availability', action: 'set' })
  setAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SetAvailabilityRuleDto,
  ) {
    return this.appointments.setAvailabilityRule(user.organizationId!, dto);
  }

  @Delete('availability/:id')
  @RequirePermissions('appointments.manage_availability')
  @Audited({ resource: 'appointment_availability', action: 'delete' })
  deleteAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.appointments.deleteAvailabilityRule(user.organizationId!, id);
  }

  @Get('time-off')
  @RequireAnyPermission('appointments.read', 'appointments.read_assigned')
  listTimeOff(
    @CurrentUser() user: AuthenticatedUser,
    @Query('staffId') staffId?: string,
  ) {
    return this.appointments.listTimeOffs(user.organizationId!, staffId);
  }

  @Post('time-off')
  @RequirePermissions('appointments.manage_availability')
  @Audited({ resource: 'appointment_time_off', action: 'create' })
  addTimeOff(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddTimeOffDto,
  ) {
    return this.appointments.addTimeOff(user.organizationId!, dto);
  }

  @Delete('time-off/:id')
  @RequirePermissions('appointments.manage_availability')
  @Audited({ resource: 'appointment_time_off', action: 'delete' })
  deleteTimeOff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.appointments.deleteTimeOff(user.organizationId!, id);
  }

  @Get('free-slots')
  @RequireAnyPermission('appointments.read', 'appointments.read_assigned')
  freeSlots(
    @CurrentUser() user: AuthenticatedUser,
    @Query('staffId') staffId: string,
    @Query('day') day: string,
  ) {
    return this.appointments.freeSlots(user.organizationId!, staffId, day);
  }

  @Get()
  @RequireAnyPermission('appointments.read', 'appointments.read_assigned')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListAppointmentsQueryDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.appointments.list(
      user.organizationId!,
      query,
      branchScope,
      assignmentScope,
    );
  }

  @Get(':id')
  @RequireAnyPermission('appointments.read', 'appointments.read_assigned')
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.appointments.getOne(
      user.organizationId!,
      id,
      branchScope,
      assignmentScope,
    );
  }

  @Post()
  @RequirePermissions('appointments.create')
  @Audited({ resource: 'appointment', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAppointmentDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.appointments.create(
      user.organizationId!,
      dto,
      user.id,
      branchScope,
    );
  }

  @Patch(':id')
  @RequirePermissions('appointments.update')
  @Audited({ resource: 'appointment', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateAppointmentDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.appointments.update(user.organizationId!, id, dto, branchScope);
  }

  @Patch(':id/reschedule')
  @RequirePermissions('appointments.update')
  @Audited({ resource: 'appointment', action: 'reschedule' })
  reschedule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RescheduleAppointmentDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.appointments.reschedule(
      user.organizationId!,
      id,
      dto,
      branchScope,
    );
  }

  @Patch(':id/cancel')
  @RequirePermissions('appointments.update')
  @Audited({ resource: 'appointment', action: 'cancel' })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CancelAppointmentDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.appointments.cancel(user.organizationId!, id, dto, branchScope);
  }

  @Patch(':id/complete')
  @RequirePermissions('appointments.update')
  @Audited({ resource: 'appointment', action: 'complete' })
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.appointments.complete(user.organizationId!, id, branchScope);
  }

  @Patch(':id/no-show')
  @RequirePermissions('appointments.update')
  @Audited({ resource: 'appointment', action: 'no_show' })
  noShow(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.appointments.noShow(user.organizationId!, id, branchScope);
  }
}
