import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import { Audited } from '../common/decorators/audited.decorator';
import { AuditInterceptor } from '../common/interceptors/audit.interceptor';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AppointmentsService } from './appointments.service';
import {
  AvailabilityRuleDto,
  CancelAppointmentDto,
  CreateAppointmentDto,
  ListAppointmentsQueryDto,
  RescheduleAppointmentDto,
  TimeOffDto,
  UpdateAppointmentDto,
} from './dto/appointment.dto';

@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller('appointments')
@UseInterceptors(AuditInterceptor)
export class AppointmentsController {
  constructor(private readonly appointmentsService: AppointmentsService) {}

  @Get('calendar')
  @RequireAnyPermission('appointments.read', 'appointments.read_assigned')
  async calendar(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('branchId') branchId?: string,
    @Query('staffId') staffId?: string,
    @Query('memberId') memberId?: string,
    @Query('leadId') leadId?: string,
  ) {
    const now = new Date();
    const windowStart = from
      ? new Date(from)
      : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const windowEnd = to
      ? new Date(to)
      : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    return this.appointmentsService.calendar(
      user.organizationId!,
      windowStart,
      windowEnd,
      { branchId, staffId, memberId, leadId },
      branchScope,
    );
  }

  @Get()
  @RequireAnyPermission('appointments.read', 'appointments.read_assigned')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Query() query: ListAppointmentsQueryDto,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.appointmentsService.list(
      user.organizationId!,
      {
        memberId: query.memberId,
        leadId: query.leadId,
        staffId: query.staffId,
        branchId: query.branchId,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        page: page ? Number(page) : undefined,
        pageSize: pageSize ? Number(pageSize) : undefined,
      },
      branchScope,
    );
  }

  @Get('availability')
  @RequireAnyPermission('appointments.read', 'appointments.read_assigned')
  async listAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Query('staffId') staffId?: string,
  ) {
    return this.appointmentsService.listAvailability(
      user.organizationId!,
      staffId,
    );
  }

  @Post('availability')
  @RequirePermissions('appointments.manage')
  @Audited({ resource: 'appointment_availability', action: 'create' })
  async setAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AvailabilityRuleDto,
  ) {
    return this.appointmentsService.setAvailability(user.organizationId!, {
      staffId: dto.staffId,
      branchId: dto.branchId,
      dayOfWeek: dto.dayOfWeek,
      startMinute: dto.startMinute,
      endMinute: dto.endMinute,
    });
  }

  @Delete('availability/:id')
  @RequirePermissions('appointments.manage')
  @Audited({ resource: 'appointment_availability', action: 'delete' })
  async deleteAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.appointmentsService.deleteAvailability(
      user.organizationId!,
      id,
    );
  }

  @Get('time-off')
  @RequireAnyPermission('appointments.read', 'appointments.read_assigned')
  async listTimeOff(
    @CurrentUser() user: AuthenticatedUser,
    @Query('staffId') staffId?: string,
  ) {
    return this.appointmentsService.listTimeOff(user.organizationId!, staffId);
  }

  @Post('time-off')
  @RequirePermissions('appointments.manage')
  @Audited({ resource: 'appointment_time_off', action: 'create' })
  async addTimeOff(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: TimeOffDto,
  ) {
    return this.appointmentsService.addTimeOff(user.organizationId!, {
      staffId: dto.staffId,
      branchId: dto.branchId,
      startAt: dto.startAt,
      endAt: dto.endAt,
      reason: dto.reason,
    });
  }

  @Delete('time-off/:id')
  @RequirePermissions('appointments.manage')
  @Audited({ resource: 'appointment_time_off', action: 'delete' })
  async deleteTimeOff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.appointmentsService.deleteTimeOff(user.organizationId!, id);
  }

  @Get('free-slots')
  @RequireAnyPermission('appointments.read', 'appointments.read_assigned')
  async freeSlots(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Query('staffId') staffId?: string,
    @Query('day') day?: string,
  ) {
    if (!staffId) {
      return {
        staffId: null,
        windows: [],
        note: 'staffId query param is required',
      };
    }
    return this.appointmentsService.freeSlots(
      user.organizationId!,
      staffId,
      day ? new Date(day) : new Date(),
      branchScope,
    );
  }

  @Get(':id')
  @RequireAnyPermission('appointments.read', 'appointments.read_assigned')
  async getOne(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Param('id') id: string,
  ) {
    return this.appointmentsService.getOne(
      user.organizationId!,
      id,
      branchScope,
    );
  }

  @Post()
  @RequirePermissions('appointments.create')
  @Audited({ resource: 'appointment', action: 'create' })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Body() dto: CreateAppointmentDto,
  ) {
    return this.appointmentsService.create(
      user.organizationId!,
      dto,
      user.id,
      branchScope,
    );
  }

  @Patch(':id')
  @RequirePermissions('appointments.update')
  @Audited({ resource: 'appointment', action: 'update' })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Param('id') id: string,
    @Body() dto: UpdateAppointmentDto,
  ) {
    return this.appointmentsService.update(
      user.organizationId!,
      id,
      dto,
      branchScope,
    );
  }

  @Patch(':id/reschedule')
  @RequirePermissions('appointments.update')
  @Audited({ resource: 'appointment', action: 'reschedule' })
  async reschedule(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Param('id') id: string,
    @Body() dto: RescheduleAppointmentDto,
  ) {
    return this.appointmentsService.reschedule(
      user.organizationId!,
      id,
      dto,
      branchScope,
    );
  }

  @Patch(':id/cancel')
  @RequirePermissions('appointments.update')
  @Audited({ resource: 'appointment', action: 'cancel' })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Param('id') id: string,
    @Body() dto: CancelAppointmentDto,
  ) {
    return this.appointmentsService.cancel(
      user.organizationId!,
      id,
      dto,
      branchScope,
    );
  }

  @Patch(':id/complete')
  @RequirePermissions('appointments.update')
  @Audited({ resource: 'appointment', action: 'complete' })
  async complete(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Param('id') id: string,
  ) {
    return this.appointmentsService.complete(
      user.organizationId!,
      id,
      branchScope,
    );
  }

  @Patch(':id/no-show')
  @RequirePermissions('appointments.update')
  @Audited({ resource: 'appointment', action: 'no_show' })
  async markNoShow(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Param('id') id: string,
  ) {
    return this.appointmentsService.markNoShow(
      user.organizationId!,
      id,
      branchScope,
    );
  }
}
