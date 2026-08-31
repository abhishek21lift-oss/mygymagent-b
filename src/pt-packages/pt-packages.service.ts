import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePtPackageDto } from './dto/create-pt-package.dto';

@Injectable()
export class PtPackagesService {
  private readonly logger = new Logger(PtPackagesService.name);

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
       FROM "pt_packages" p WHERE p."id" = $1 AND p."organizationId" = $2`,
      id,
      organizationId,
    );
    if (!rows[0]) throw new NotFoundException('PT package not found');
    return rows[0];
  }

  async create(
    organizationId: string,
    dto: CreatePtPackageDto,
    createdByUserId: string,
  ) {
    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);
    if (startDate > endDate)
      throw new BadRequestException('End date must be on or after start date');

    const [member, branch] = await Promise.all([
      this.prisma.member.findFirst({
        where: { id: dto.memberId, organizationId },
      }),
      this.prisma.branch.findFirst({
        where: { id: dto.branchId, organizationId },
      }),
    ]);
    if (!member)
      throw new BadRequestException('Member not found in this organization');
    if (!branch)
      throw new BadRequestException('Branch not found in this organization');

    if (dto.templateId) {
      const template = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT id FROM "pt_package_templates" WHERE id=$1 AND "organizationId"=$2 AND "isActive"=true`,
        dto.templateId,
        organizationId,
      );
      if (!template[0])
        throw new BadRequestException(
          'Package template not found or inactive in this organization',
        );
    }

    const id = crypto.randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "pt_packages" (id,"organizationId","branchId","memberId","templateId",name,"totalSessions","startDate","endDate",price,currency,"status","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ACTIVE',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        id,
        organizationId,
        dto.branchId,
        dto.memberId,
        dto.templateId ?? null,
        dto.name,
        dto.totalSessions,
        startDate,
        endDate,
        dto.price,
        dto.currency ?? 'USD',
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "audit_logs" (id,"organizationId","actorUserId",action,resource,"resourceId","afterState","createdAt")
         VALUES ($1,$2,$3,'CREATE','PT_PACKAGE',$4,$5,CURRENT_TIMESTAMP)`,
        crypto.randomUUID(),
        organizationId,
        createdByUserId,
        id,
        JSON.stringify({
          memberId: dto.memberId,
          branchId: dto.branchId,
          totalSessions: dto.totalSessions,
        }),
      );
    });
    return this.getOne(organizationId, id);
  }

  /**
   * Atomically consumes one session from the earliest-expiring eligible
   * package for a completed PT session. If the member has no eligible
   * package, the session remains valid as a pay-as-you-go session.
   */
  async consumeForCompletedSession(
    tx: Prisma.TransactionClient,
    organizationId: string,
    ptSessionId: string,
    memberId: string,
    sessionStartTime: Date,
  ) {
    const existing = await tx.$queryRawUnsafe<any[]>(
      `SELECT id FROM "pt_session_consumptions"
       WHERE "organizationId"=$1 AND "ptSessionId"=$2 LIMIT 1`,
      organizationId,
      ptSessionId,
    );
    if (existing[0])
      return {
        consumed: false,
        packageId: existing[0].packageId ?? null,
        alreadyConsumed: true,
      };

    const packages = await tx.$queryRawUnsafe<any[]>(
      `SELECT id, "totalSessions", "usedSessions"
       FROM "pt_packages"
       WHERE "organizationId"=$1 AND "memberId"=$2 AND "status"='ACTIVE'
         AND "startDate" <= $3 AND "endDate" >= $3
         AND "usedSessions" < "totalSessions"
       ORDER BY "endDate" ASC, "createdAt" ASC
       FOR UPDATE
       LIMIT 1`,
      organizationId,
      memberId,
      sessionStartTime,
    );
    const pkg = packages[0];
    if (!pkg) {
      return { consumed: false, packageId: null, alreadyConsumed: false };
    }

    // Guard against consuming a package that is no longer ACTIVE (e.g., already COMPLETED by another transaction)
    if (pkg.status && pkg.status !== 'ACTIVE') {
      this.logger.warn(`Package ${pkg.id} status is ${pkg.status} – treating as already consumed`);
      return { consumed: false, packageId: pkg.id, alreadyConsumed: true };
    }

    const consumptionId = crypto.randomUUID();
    await tx.$executeRawUnsafe(
      `INSERT INTO "pt_session_consumptions" (id,"organizationId","packageId","ptSessionId","sessions","createdAt")
       VALUES ($1,$2,$3,$4,1,CURRENT_TIMESTAMP)`,
      consumptionId,
      organizationId,
      pkg.id,
      ptSessionId,
    );

    await tx.$executeRawUnsafe(
      `UPDATE "pt_packages"
       SET "usedSessions"="usedSessions"+1,
           "status"=CASE WHEN "usedSessions"+1 >= "totalSessions" THEN 'COMPLETED'::"PtPackageStatus" ELSE "status" END,
           "updatedAt"=CURRENT_TIMESTAMP
       WHERE id=$1 AND "organizationId"=$2`,
      pkg.id,
      organizationId,
    );

    return { consumed: true, packageId: pkg.id, alreadyConsumed: false };
  }
}
