import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { CreateAppointmentDto } from './dto/create-appointment.dto';
import type { UpdateAppointmentDto } from './dto/update-appointment.dto';
import type { RescheduleAppointmentDto } from './dto/reschedule-appointment.dto';

@Injectable()
export class AppointmentsService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertContext(org: string, branchId: string, staffId?: string, memberId?: string, leadId?: string) {
    if (!(await this.prisma.branch.findFirst({ where: { id: branchId, organizationId: org } }))) throw new BadRequestException('Branch not found in this organization');
    if (staffId && !(await this.prisma.staffProfile.findFirst({ where: { id: staffId, organizationId: org } }))) throw new BadRequestException('Staff not found in this organization');
    if (memberId && !(await this.prisma.member.findFirst({ where: { id: memberId, organizationId: org } }))) throw new BadRequestException('Member not found in this organization');
    if (leadId && !(await this.prisma.lead.findFirst({ where: { id: leadId, organizationId: org } }))) throw new BadRequestException('Lead not found in this organization');
  }

  private async conflict(org: string, branch: string, start: Date, end: Date, staff?: string, member?: string, exclude?: string) {
    if (!(start < end)) throw new BadRequestException('Appointment end time must be after start time');
    const a = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM appointments WHERE "organizationId"=${org} AND "branchId"=${branch}
      AND status IN ('BOOKED','RESCHEDULED') AND "startTime" < ${end} AND "endTime" > ${start}
      AND (${exclude ?? null}::text IS NULL OR id <> ${exclude ?? null})
      AND ((${staff ?? null}::text IS NOT NULL AND "staffId"=${staff ?? null}) OR (${member ?? null}::text IS NOT NULL AND "memberId"=${member ?? null})) LIMIT 1`;
    if (a.length) throw new BadRequestException('Time conflicts with an existing appointment');
    const p = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM pt_sessions WHERE "organizationId"=${org} AND "branchId"=${branch}
      AND status IN ('SCHEDULED','COMPLETED') AND "startTime" < ${end} AND "endTime" > ${start}
      AND ((${staff ?? null}::text IS NOT NULL AND "trainerId"=${staff ?? null}) OR (${member ?? null}::text IS NOT NULL AND "memberId"=${member ?? null})) LIMIT 1`;
    if (p.length) throw new BadRequestException('Time conflicts with an existing PT session');
  }

  private async one(org: string, id: string) {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT a.*, b.name AS "branchName", sp.id AS "staffProfileId", u."firstName" AS "staffFirstName", u."lastName" AS "staffLastName",
      m."firstName" AS "memberFirstName",m."lastName" AS "memberLastName",m.email AS "memberEmail",m.phone AS "memberPhone",
      l."firstName" AS "leadFirstName",l."lastName" AS "leadLastName",l.email AS "leadEmail",l.phone AS "leadPhone"
      FROM appointments a JOIN branches b ON b.id=a."branchId"
      LEFT JOIN staff_profiles sp ON sp.id=a."staffId" LEFT JOIN users u ON u.id=sp."userId"
      LEFT JOIN members m ON m.id=a."memberId" LEFT JOIN leads l ON l.id=a."leadId"
      WHERE a.id=${id} AND a."organizationId"=${org} LIMIT 1`;
    if (!rows.length) throw new NotFoundException('Appointment not found');
    const r=rows[0];
    return {...r,branch:{id:r.branchId,name:r.branchName},staff:r.staffId?{id:r.staffId,firstName:r.staffFirstName,lastName:r.staffLastName}:null,member:r.memberId?{id:r.memberId,firstName:r.memberFirstName,lastName:r.memberLastName,email:r.memberEmail,phone:r.memberPhone}:null,lead:r.leadId?{id:r.leadId,firstName:r.leadFirstName,lastName:r.leadLastName,email:r.leadEmail,phone:r.leadPhone}:null};
  }

  async list(org:string,q:PaginationQueryDto,f:any={}) {
    const page=q.page??1, size=q.pageSize??20, offset=(page-1)*size;
    const order=q.order==='desc'?'DESC':'ASC';
    const sql=`SELECT a.*,b.name AS "branchName",u."firstName" AS "staffFirstName",u."lastName" AS "staffLastName",m."firstName" AS "memberFirstName",m."lastName" AS "memberLastName",m.email AS "memberEmail",m.phone AS "memberPhone",l."firstName" AS "leadFirstName",l."lastName" AS "leadLastName",l.email AS "leadEmail",l.phone AS "leadPhone" FROM appointments a JOIN branches b ON b.id=a."branchId" LEFT JOIN staff_profiles sp ON sp.id=a."staffId" LEFT JOIN users u ON u.id=sp."userId" LEFT JOIN members m ON m.id=a."memberId" LEFT JOIN leads l ON l.id=a."leadId" WHERE a."organizationId"=$1 AND ($2::text IS NULL OR a."memberId"=$2) AND ($3::text IS NULL OR a."leadId"=$3) AND ($4::text IS NULL OR a."staffId"=$4) AND ($5::text IS NULL OR a."branchId"=$5) AND ($6::text IS NULL OR a.type::text=$6) AND ($7::timestamptz IS NULL OR a."endTime">=$7) AND ($8::timestamptz IS NULL OR a."startTime"<=$8) ORDER BY a."startTime" ${order} LIMIT $9 OFFSET $10`;
    const args=[org,f.memberId??null,f.leadId??null,f.staffId??null,f.branchId??null,f.type??null,f.from??null,f.to??null,size,offset];
    const rows=await this.prisma.$queryRawUnsafe<any[]>(sql,...args);
    const countRows=await this.prisma.$queryRawUnsafe<{count:bigint}[]>(`SELECT COUNT(*)::bigint count FROM appointments a WHERE a."organizationId"=$1 AND ($2::text IS NULL OR a."memberId"=$2) AND ($3::text IS NULL OR a."leadId"=$3) AND ($4::text IS NULL OR a."staffId"=$4) AND ($5::text IS NULL OR a."branchId"=$5) AND ($6::text IS NULL OR a.type::text=$6) AND ($7::timestamptz IS NULL OR a."endTime">=$7) AND ($8::timestamptz IS NULL OR a."startTime"<=$8)`,...args.slice(0,8));
    const items=rows.map(r=>({...r,branch:{id:r.branchId,name:r.branchName},staff:r.staffId?{id:r.staffId,firstName:r.staffFirstName,lastName:r.staffLastName}:null,member:r.memberId?{id:r.memberId,firstName:r.memberFirstName,lastName:r.memberLastName,email:r.memberEmail,phone:r.memberPhone}:null,lead:r.leadId?{id:r.leadId,firstName:r.leadFirstName,lastName:r.leadLastName,email:r.leadEmail,phone:r.leadPhone}:null}));
    const total=Number(countRows[0]?.count??0); return {items,page,pageSize:size,total,totalPages:Math.max(1,Math.ceil(total/size))};
  }

  async getOne(org:string,id:string){return this.one(org,id);}
  async create(org:string,userId:string,dto:CreateAppointmentDto){const s=new Date(dto.startTime),e=new Date(dto.endTime);await this.assertContext(org,dto.branchId,dto.staffId,dto.memberId,dto.leadId);await this.conflict(org,dto.branchId,s,e,dto.staffId,dto.memberId);const r=await this.prisma.$queryRaw<{id:string}[]>`INSERT INTO appointments ("organizationId","branchId","staffId","memberId","leadId",type,title,"startTime","endTime",notes,"clientName","clientEmail","clientPhone","createdByUserId") VALUES (${org},${dto.branchId},${dto.staffId??null},${dto.memberId??null},${dto.leadId??null},${dto.type}::"AppointmentType",${dto.title},${s},${e},${dto.notes??null},${dto.clientName??null},${dto.clientEmail??null},${dto.clientPhone??null},${userId}) RETURNING id`;return this.one(org,r[0].id);}
  async update(org:string,id:string,dto:UpdateAppointmentDto){const c=await this.one(org,id);const b=dto.branchId??c.branchId,s=dto.staffId??c.staffId??undefined,m=dto.memberId??c.memberId??undefined,l=dto.leadId??c.leadId??undefined;const st=new Date(dto.startTime??c.startTime),en=new Date(dto.endTime??c.endTime);await this.assertContext(org,b,s,m,l);await this.conflict(org,b,st,en,s,m,id);await this.prisma.$executeRaw`UPDATE appointments SET "branchId"=${b},"staffId"=${s??null},"memberId"=${m??null},"leadId"=${l??null},type=${dto.type??c.type}::"AppointmentType",title=${dto.title??c.title},"startTime"=${st},"endTime"=${en},notes=${dto.notes??c.notes},"clientName"=${dto.clientName??c.clientName},"clientEmail"=${dto.clientEmail??c.clientEmail},"clientPhone"=${dto.clientPhone??c.clientPhone},"updatedAt"=CURRENT_TIMESTAMP WHERE id=${id} AND "organizationId"=${org}`;return this.one(org,id);}
  async reschedule(org:string,id:string,dto:RescheduleAppointmentDto){const c=await this.one(org,id);const s=new Date(dto.startTime),e=new Date(dto.endTime);await this.conflict(org,c.branchId,s,e,c.staffId??undefined,c.memberId??undefined,id);await this.prisma.$executeRaw`UPDATE appointments SET "startTime"=${s},"endTime"=${e},status='RESCHEDULED',"updatedAt"=CURRENT_TIMESTAMP WHERE id=${id} AND "organizationId"=${org}`;return this.one(org,id);}
  async transition(org:string,id:string,status:'CANCELLED'|'COMPLETED'|'NO_SHOW',reason?:string){await this.one(org,id);await this.prisma.$executeRaw`UPDATE appointments SET status=${status}::"AppointmentStatus","cancellationReason"=${(status==='CANCELLED'||status==='NO_SHOW')?reason??null:null},"updatedAt"=CURRENT_TIMESTAMP WHERE id=${id} AND "organizationId"=${org}`;return this.one(org,id);}

  async calendar(org:string,from?:string,to?:string,branchId?:string,staffId?:string,memberId?:string,leadId?:string){const a=await this.list(org,{page:1,pageSize:100,order:'asc'},{from,to,branchId,staffId,memberId,leadId});const p=await this.prisma.$queryRaw<any[]>`SELECT p.id,p.type,p.status,p."startTime",p."endTime",p."branchId",p."trainerId" AS "staffId",p."memberId",p.notes,u."firstName",u."lastName",m."firstName" AS "memberFirstName",m."lastName" AS "memberLastName" FROM pt_sessions p LEFT JOIN staff_profiles sp ON sp.id=p."trainerId" LEFT JOIN users u ON u.id=sp."userId" LEFT JOIN members m ON m.id=p."memberId" WHERE p."organizationId"=${org} AND (${from??null}::timestamptz IS NULL OR p."endTime">=${from??null}) AND (${to??null}::timestamptz IS NULL OR p."startTime"<=${to??null}) AND (${branchId??null}::text IS NULL OR p."branchId"=${branchId??null}) AND (${staffId??null}::text IS NULL OR p."trainerId"=${staffId??null}) AND (${memberId??null}::text IS NULL OR p."memberId"=${memberId??null})`;return [...a.items.map((x:any)=>({id:x.id,source:'APPOINTMENT',type:x.type,status:x.status,title:x.title,startTime:x.startTime,endTime:x.endTime,branchId:x.branchId,staffId:x.staffId,staffName:x.staff?`${x.staff.firstName} ${x.staff.lastName}`:null,memberId:x.memberId,memberName:x.member?`${x.member.firstName} ${x.member.lastName}`:null,leadId:x.leadId,notes:x.notes})),...p.map(x=>({id:x.id,source:'PT_SESSION',type:x.type,status:x.status,title:'Personal Training',startTime:x.startTime,endTime:x.endTime,branchId:x.branchId,staffId:x.staffId,staffName:x.firstName?`${x.firstName} ${x.lastName}`:null,memberId:x.memberId,memberName:x.memberFirstName?`${x.memberFirstName} ${x.memberLastName}`:null,leadId:null,notes:x.notes}))].sort((x,y)=>new Date(x.startTime).getTime()-new Date(y.startTime).getTime());}
  async availability(org:string,staffId?:string){return this.prisma.$queryRaw<any[]>`SELECT r.*,u."firstName",u."lastName" FROM trainer_availability_rules r JOIN staff_profiles sp ON sp.id=r."staffId" JOIN users u ON u.id=sp."userId" WHERE r."organizationId"=${org} AND (${staffId??null}::text IS NULL OR r."staffId"=${staffId??null}) AND r."isActive"=true ORDER BY r."dayOfWeek",r."startMinute"`;}
  async setAvailability(org:string,i:any){if(i.dayOfWeek<0||i.dayOfWeek>6||i.startMinute<0||i.endMinute>1440||i.startMinute>=i.endMinute)throw new BadRequestException('Invalid availability window');await this.assertContext(org,i.branchId??(await this.prisma.staffProfile.findFirst({where:{id:i.staffId,organizationId:org}}))?.branchId??'',i.staffId);await this.prisma.$executeRaw`INSERT INTO trainer_availability_rules ("organizationId","staffId","branchId","dayOfWeek","startMinute","endMinute") VALUES (${org},${i.staffId},${i.branchId??null},${i.dayOfWeek},${i.startMinute},${i.endMinute})`;return {ok:true as const};}
  async deleteAvailability(org:string,id:string){await this.prisma.$executeRaw`DELETE FROM trainer_availability_rules WHERE id=${id} AND "organizationId"=${org}`;return {ok:true as const};}
  async timeOffs(org:string,staffId?:string){return this.prisma.$queryRaw<any[]>`SELECT t.*,u."firstName",u."lastName" FROM trainer_time_offs t JOIN staff_profiles sp ON sp.id=t."staffId" JOIN users u ON u.id=sp."userId" WHERE t."organizationId"=${org} AND (${staffId??null}::text IS NULL OR t."staffId"=${staffId??null}) ORDER BY t."startAt"`;}
  async addTimeOff(org:string,i:any){const s=new Date(i.startAt),e=new Date(i.endAt);if(s>=e)throw new BadRequestException('Time-off end must be after start');await this.assertContext(org,i.branchId??(await this.prisma.staffProfile.findFirst({where:{id:i.staffId,organizationId:org}}))?.branchId??'',i.staffId);await this.prisma.$executeRaw`INSERT INTO trainer_time_offs ("organizationId","staffId","branchId","startAt","endAt",reason) VALUES (${org},${i.staffId},${i.branchId??null},${s},${e},${i.reason??null})`;return {ok:true as const};}
  async deleteTimeOff(org:string,id:string){await this.prisma.$executeRaw`DELETE FROM trainer_time_offs WHERE id=${id} AND "organizationId"=${org}`;return {ok:true as const};}
  async freeSlots(org:string,staffId:string,day:string){const d=new Date(`${day}T00:00:00.000Z`),dow=(d.getUTCDay()+6)%7,endDay=new Date(d.getTime()+86400000);const rules=await this.prisma.$queryRaw<any[]>`SELECT "startMinute","endMinute" FROM trainer_availability_rules WHERE "organizationId"=${org} AND "staffId"=${staffId} AND "dayOfWeek"=${dow} AND "isActive"=true`;const busy=await this.prisma.$queryRaw<any[]>`SELECT "startTime","endTime" FROM appointments WHERE "organizationId"=${org} AND "staffId"=${staffId} AND status IN ('BOOKED','RESCHEDULED') AND "startTime"<${endDay} AND "endTime">=${d} UNION ALL SELECT "startTime","endTime" FROM pt_sessions WHERE "organizationId"=${org} AND "trainerId"=${staffId} AND status='SCHEDULED' AND "startTime"<${endDay} AND "endTime">=${d}`;const windows=rules.map(r=>{const w={start:new Date(d.getTime()+r.startMinute*60000),end:new Date(d.getTime()+r.endMinute*60000),free:[] as any[]};let c=w.start;for(const b of busy.sort((x,y)=>new Date(x.startTime).getTime()-new Date(y.startTime).getTime())){const s=new Date(b.startTime),e=new Date(b.endTime);if(e<=c||s>=w.end)continue;if(s>c)w.free.push({start:c.toISOString(),end:new Date(Math.min(s.getTime(),w.end.getTime())).toISOString()});if(e>c)c=e;if(c>=w.end)break;}if(c<w.end)w.free.push({start:c.toISOString(),end:w.end.toISOString()});return {start:w.start.toISOString(),end:w.end.toISOString(),free:w.free};});return {staffId,windows};}
}
