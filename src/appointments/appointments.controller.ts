import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, UseInterceptors } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { AuditInterceptor } from '../common/interceptors/audit.interceptor';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AppointmentsService } from './appointments.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto';

const org=(u:AuthenticatedUser)=>{if(!u.organizationId)throw new BadRequestException('Organization context is required');return u.organizationId;};
@Controller('appointments') @UseInterceptors(AuditInterceptor)
export class AppointmentsController{
 constructor(private readonly service:AppointmentsService){}
 @Get() @RequirePermissions('appointments.read') list(@CurrentUser()u:AuthenticatedUser,@Query('page')page?:string,@Query('pageSize')pageSize?:string,@Query('order')order?:'asc'|'desc',@Query('memberId')memberId?:string,@Query('leadId')leadId?:string,@Query('staffId')staffId?:string,@Query('branchId')branchId?:string,@Query('type')type?:string,@Query('from')from?:string,@Query('to')to?:string){return this.service.list(org(u),{page:Math.max(1,Number(page)||1),pageSize:Math.min(100,Math.max(1,Number(pageSize)||20)),order},{memberId,leadId,staffId,branchId,type,from,to});}
 @Get('calendar') @RequirePermissions('appointments.read') calendar(@CurrentUser()u:AuthenticatedUser,@Query('from')from?:string,@Query('to')to?:string,@Query('branchId')branchId?:string,@Query('staffId')staffId?:string,@Query('memberId')memberId?:string,@Query('leadId')leadId?:string){return this.service.calendar(org(u),from,to,branchId,staffId,memberId,leadId);}
 @Get('availability') @RequirePermissions('appointments.read') availability(@CurrentUser()u:AuthenticatedUser,@Query('staffId')staffId?:string){return this.service.availability(org(u),staffId);}
 @Post('availability') @RequirePermissions('appointments.manage') setAvailability(@CurrentUser()u:AuthenticatedUser,@Body()body:any){return this.service.setAvailability(org(u),body);}
 @Delete('availability/:id') @RequirePermissions('appointments.manage') deleteAvailability(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string){return this.service.deleteAvailability(org(u),id);}
 @Get('time-off') @RequirePermissions('appointments.read') timeOff(@CurrentUser()u:AuthenticatedUser,@Query('staffId')staffId?:string){return this.service.timeOffs(org(u),staffId);}
 @Post('time-off') @RequirePermissions('appointments.manage') addTimeOff(@CurrentUser()u:AuthenticatedUser,@Body()body:any){return this.service.addTimeOff(org(u),body);}
 @Delete('time-off/:id') @RequirePermissions('appointments.manage') deleteTimeOff(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string){return this.service.deleteTimeOff(org(u),id);}
 @Get('free-slots') @RequirePermissions('appointments.read') freeSlots(@CurrentUser()u:AuthenticatedUser,@Query('staffId')staffId:string,@Query('day')day:string){return this.service.freeSlots(org(u),staffId,day);}
 @Get(':id') @RequirePermissions('appointments.read') getOne(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string){return this.service.getOne(org(u),id);}
 @Post() @RequirePermissions('appointments.create') create(@CurrentUser()u:AuthenticatedUser,@Body()dto:CreateAppointmentDto){return this.service.create(org(u),u.id,dto);}
 @Patch(':id') @RequirePermissions('appointments.manage') update(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string,@Body()dto:UpdateAppointmentDto){return this.service.update(org(u),id,dto);}
 @Patch(':id/reschedule') @RequirePermissions('appointments.manage') reschedule(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string,@Body()dto:RescheduleAppointmentDto){return this.service.reschedule(org(u),id,dto);}
 @Patch(':id/cancel') @RequirePermissions('appointments.manage') cancel(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string,@Body()body:{reason?:string}){return this.service.transition(org(u),id,'CANCELLED',body?.reason);}
 @Patch(':id/complete') @RequirePermissions('appointments.manage') complete(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string){return this.service.transition(org(u),id,'COMPLETED');}
 @Patch(':id/no-show') @RequirePermissions('appointments.manage') noShow(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string){return this.service.transition(org(u),id,'NO_SHOW');}
}
