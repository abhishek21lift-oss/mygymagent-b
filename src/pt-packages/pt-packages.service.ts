import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePtPackageDto } from './dto/create-pt-package.dto';

@Injectable()
export class PtPackagesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, memberId?: string) {
    return this.prisma.$queryRawUnsafe<any[]>(
      `SELECT p.*, GREATEST(p."totalSessions" - p."usedSessions", 0) AS "remainingSessions"
       FROM "pt_packages" p
       WHERE p."organizationId" = $1 ${memberId ? 'AND p."memberId" = $2' : ''}
       ORDER BY p."endDate" ASC`,
      ...(memberId ? [organizationId, memberId] : [organizationId]),
    );
  }

  async getOne(organizationId: string, id: string) {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT p.*, GREATEST(p."totalSessions" - p."usedSessions", 0) AS "remainingSessions"
       FROM "pt_packages" p WHERE p."id" = $1 AND p."organizationId" = $2`, id, organizationId,
    );
    if (!rows[0]) throw new NotFoundException('PT package not found');
    return rows[0];
  }

  async create(organizationId: string, dto: CreatePtPackageDto, createdByUserId: string) {
    if (new Date(dto.startDate) > new Date(dto.endDate)) throw new BadRequestException('End date must be on or after start date');
    const member = await this.prisma.member.findFirst({ where: { id: dto.memberId, organizationId } });
    if (!member) throw new BadRequestException('Member not found in this organization');
    const branch = await this.prisma.branch.findFirst({ where: { id: dto.branchId, organizationId } });
    if (!branch) throw new BadRequestException('Branch not found in this organization');
    if (dto.templateId) {
      const template = await this.prisma.$queryRawUnsafe<any[]>(`SELECT id FROM "pt_package_templates" WHERE id=$1 AND "organizationId"=$2`, dto.templateId, organizationId);
      if (!template[0]) throw new BadRequestException('Package template not found in this organization');
    }
    const id = crypto.randomUUID();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "pt_packages" (id,"organizationId","branchId","memberId","templateId",name,"totalSessions","startDate","endDate",price,currency,"status","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ACTIVE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      id, organizationId, dto.branchId, dto.memberId, dto.templateId ?? null, dto.name, dto.totalSessions, new Date(dto.startDate), new Date(dto.endDate), dto.price, dto.currency ?? 'USD',
    );
    await this.prisma.$executeRawUnsafe(`INSERT INTO "audit_logs" (id,"organizationId","actorUserId",action,resource,"resourceId","afterState","createdAt") VALUES ($1,$2,$3,'CREATE','PT_PACKAGE',$4,$5,CURRENT_TIMESTAMP)`, crypto.randomUUID(), organizationId, createdByUserId, id, JSON.stringify({ memberId: dto.memberId, totalSessions: dto.totalSessions }));
    return this.getOne(organizationId, id);
  }
}
