import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ClassesService {
  constructor(private readonly prisma: PrismaService) {}
  private async branch(org: string, id: string) {
    const r = await this.prisma.branch.findFirst({ where: { id, organizationId: org, status: 'ACTIVE', deletedAt: null }, select: { id: true } });
    if (!r) throw new BadRequestException('Branch does not belong to this organization');
  }
  private async user(org: string, id?: string) {
    if (!id) return;
    const r = await this.prisma.user.findFirst({ where: { id, organizationId: org, deletedAt: null }, select: { id: true } });
    if (!r) throw new BadRequestException('Instructor does not belong to this organization');
  }
  private async member(org: string, id: string) {
    const r = await this.prisma.member.findFirst({ where: { id, organizationId: org, deletedAt: null }, select: { id: true } });
    if (!r) throw new BadRequestException('Member does not belong to this organization');
  }
  programs(org: string, q: any) {
    return this.prisma.$queryRawUnsafe(
      'SELECT p.*,b.name AS "branchName",u."firstName" AS "instructorFirstName",u."lastName" AS "instructorLastName" FROM class_programs p JOIN branches b ON b.id=p."branchId" LEFT JOIN users u ON u.id=p."instructorId" WHERE p."organizationId"=$1 AND ($2::text IS NULL OR p."branchId"=$2) AND ($3::text IS NULL OR p.status::text=$3) ORDER BY p.name ASC',
      org,q.branchId??null,q.status??null,
    );
  }
  async createProgram(org: string, dto: any) {
    await this.branch(org,dto.branchId); await this.user(org,dto.instructorId);
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      'INSERT INTO class_programs ("organizationId","branchId","name","description","capacity","durationMinutes","instructorId") VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      org,dto.branchId,dto.name.trim(),dto.description??null,dto.capacity,dto.durationMinutes,dto.instructorId??null,
    );
    return rows[0];
  }
  async sessions(org: string, q: any) {
    const from=q.from?new Date(q.from):new Date(), to=q.to?new Date(q.to):new Date(from.getTime()+14*86400000);
    if (!(from<to)) throw new BadRequestException('to must be after from');
    return this.prisma.$queryRawUnsafe(
      'SELECT s.*,p.name AS "className",b.name AS "branchName",COALESCE(s.capacity,p.capacity) AS "effectiveCapacity",u."firstName" AS "instructorFirstName",u."lastName" AS "instructorLastName",COUNT(cb.id) FILTER (WHERE cb.status=\'BOOKED\')::int AS "bookedCount",COUNT(cb.id) FILTER (WHERE cb.status=\'WAITLISTED\')::int AS "waitlistCount" FROM class_sessions s JOIN class_programs p ON p.id=s."classProgramId" JOIN branches b ON b.id=s."branchId" LEFT JOIN users u ON u.id=COALESCE(s."instructorId",p."instructorId") LEFT JOIN class_bookings cb ON cb."sessionId"=s.id WHERE s."organizationId"=$1 AND s."startTime">=$2 AND s."startTime"<=$3 AND ($4::text IS NULL OR s."branchId"=$4) AND ($5::text IS NULL OR COALESCE(s."instructorId",p."instructorId")=$5) GROUP BY s.id,p.id,b.id,u.id ORDER BY s."startTime" ASC',
      org,from,to,q.branchId??null,q.instructorId??null,
    );
  }
  async createSession(org: string, dto: any) {
    await this.branch(org,dto.branchId); await this.user(org,dto.instructorId);
    const p=await this.prisma.$queryRawUnsafe<any[]>(
      'SELECT * FROM class_programs WHERE id=$1 AND "organizationId"=$2 AND "branchId"=$3 AND status=\'ACTIVE\'',dto.classProgramId,org,dto.branchId);
    if (!p.length) throw new BadRequestException('Active class program not found for this branch');
    const start=new Date(dto.startTime),end=new Date(dto.endTime); if (!(start<end)) throw new BadRequestException('endTime must be after startTime');
    const instructor=dto.instructorId??p[0].instructorId??null; await this.user(org,instructor??undefined);
    const rows=await this.prisma.$queryRawUnsafe<any[]>(
      'INSERT INTO class_sessions ("organizationId","branchId","classProgramId","instructorId","startTime","endTime","capacity") VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      org,dto.branchId,dto.classProgramId,instructor,start,end,dto.capacity??null);
    return rows[0];
  }
  async book(org: string, sessionId: string, memberId: string) {
    await this.member(org,memberId);
    return this.prisma.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))',sessionId);
      const s=await tx.$queryRawUnsafe<any[]>(
        'SELECT s.*,COALESCE(s.capacity,p.capacity) AS "effectiveCapacity" FROM class_sessions s JOIN class_programs p ON p.id=s."classProgramId" WHERE s.id=$1 AND s."organizationId"=$2 AND s.status=\'ACTIVE\'',sessionId,org);
      if (!s.length) throw new NotFoundException('Class session not found');
      const existing=await tx.$queryRawUnsafe<any[]>('SELECT * FROM class_bookings WHERE "sessionId"=$1 AND "memberId"=$2',sessionId,memberId);
      if (existing.length && ['BOOKED','WAITLISTED'].includes(existing[0].status)) throw new BadRequestException('Member is already booked or waitlisted');
      const count=Number((await tx.$queryRawUnsafe<any[]>('SELECT COUNT(*)::int AS count FROM class_bookings WHERE "sessionId"=$1 AND status=\'BOOKED\'',sessionId))[0]?.count??0);
      const cap=Number(s[0].effectiveCapacity);
      if (existing.length) {
        if (count<cap) return (await tx.$queryRawUnsafe<any[]>('UPDATE class_bookings SET status=\'BOOKED\',"waitlistPosition"=NULL,"cancelledAt"=NULL,"attendanceAt"=NULL,"bookedAt"=CURRENT_TIMESTAMP,"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1 RETURNING *',existing[0].id))[0];
        const pos=Number((await tx.$queryRawUnsafe<any[]>('SELECT COALESCE(MAX("waitlistPosition"),0)::int+1 AS position FROM class_bookings WHERE "sessionId"=$1 AND status=\'WAITLISTED\'',sessionId))[0].position);
        return (await tx.$queryRawUnsafe<any[]>('UPDATE class_bookings SET status=\'WAITLISTED\',"waitlistPosition"=$1,"cancelledAt"=NULL,"attendanceAt"=NULL,"bookedAt"=CURRENT_TIMESTAMP,"updatedAt"=CURRENT_TIMESTAMP WHERE id=$2 RETURNING *',pos,existing[0].id))[0];
      }
      if (count<cap) return (await tx.$queryRawUnsafe<any[]>('INSERT INTO class_bookings ("organizationId","branchId","sessionId","memberId","status") VALUES ($1,$2,$3,$4,\'BOOKED\') RETURNING *',org,s[0].branchId,sessionId,memberId))[0];
      const pos=Number((await tx.$queryRawUnsafe<any[]>('SELECT COALESCE(MAX("waitlistPosition"),0)::int+1 AS position FROM class_bookings WHERE "sessionId"=$1 AND status=\'WAITLISTED\'',sessionId))[0].position);
      return (await tx.$queryRawUnsafe<any[]>('INSERT INTO class_bookings ("organizationId","branchId","sessionId","memberId","status","waitlistPosition") VALUES ($1,$2,$3,$4,\'WAITLISTED\',$5) RETURNING *',org,s[0].branchId,sessionId,memberId,pos))[0];
    });
  }
  async cancel(org: string, bookingId: string) {
    return this.prisma.$transaction(async tx=>{
      const rows=await tx.$queryRawUnsafe<any[]>('SELECT * FROM class_bookings WHERE id=$1 AND "organizationId"=$2 AND status IN (\'BOOKED\',\'WAITLISTED\') FOR UPDATE',bookingId,org);
      if (!rows.length) throw new NotFoundException('Active booking not found');
      await tx.$executeRawUnsafe('UPDATE class_bookings SET status=\'CANCELLED\',"cancelledAt"=CURRENT_TIMESTAMP,"waitlistPosition"=NULL,"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1',bookingId);
      if(rows[0].status==='BOOKED'){
        const next=await tx.$queryRawUnsafe<any[]>('SELECT id FROM class_bookings WHERE "organizationId"=$1 AND "sessionId"=$2 AND status=\'WAITLISTED\' ORDER BY "waitlistPosition" ASC,"createdAt" ASC LIMIT 1 FOR UPDATE',org,rows[0].sessionId);
        if(next.length) await tx.$executeRawUnsafe('UPDATE class_bookings SET status=\'BOOKED\',"waitlistPosition"=NULL,"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1',next[0].id);
      }
      return {ok:true};
    });
  }
  async attendance(org:string,bookingId:string,status:'ATTENDED'|'NO_SHOW'){
    const rows=await this.prisma.$queryRawUnsafe<any[]>('SELECT * FROM class_bookings WHERE id=$1 AND "organizationId"=$2 AND status IN (\'BOOKED\',\'ATTENDED\',\'NO_SHOW\')',bookingId,org);
    if(!rows.length) throw new NotFoundException('Booking not found');
    return (await this.prisma.$queryRawUnsafe<any[]>('UPDATE class_bookings SET status=$1::"ClassBookingStatus","attendanceAt"=CURRENT_TIMESTAMP,"updatedAt"=CURRENT_TIMESTAMP WHERE id=$2 RETURNING *',status,bookingId))[0];
  }
  async analytics(org:string,from?:string,to?:string,branchId?:string){
    const start=from?new Date(from):new Date(Date.now()-30*86400000),end=to?new Date(to):new Date();
    if(!(start<end)) throw new BadRequestException('to must be after from');
    return this.prisma.$queryRawUnsafe(
      'SELECT p.id AS "classProgramId",p.name AS "className",COUNT(cb.id)::int AS "totalBookings",COUNT(cb.id) FILTER (WHERE cb.status=\'ATTENDED\')::int AS "attended",COUNT(cb.id) FILTER (WHERE cb.status=\'NO_SHOW\')::int AS "noShows",COUNT(cb.id) FILTER (WHERE cb.status=\'WAITLISTED\')::int AS "waitlisted" FROM class_programs p JOIN class_sessions s ON s."classProgramId"=p.id LEFT JOIN class_bookings cb ON cb."sessionId"=s.id WHERE p."organizationId"=$1 AND s."startTime">=$2 AND s."startTime"<=$3 AND ($4::text IS NULL OR s."branchId"=$4) GROUP BY p.id,p.name ORDER BY "totalBookings" DESC',
      org,start,end,branchId??null);
  }
}