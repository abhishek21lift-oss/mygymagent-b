import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePtPackageDto } from './dto/create-pt-package.dto';

function withRemaining<
  T extends { totalSessions: number; usedSessions: number },
>(pkg: T) {
  return {
    ...pkg,
    remainingSessions: Math.max(pkg.totalSessions - pkg.usedSessions, 0),
  };
}

@Injectable()
export class PtPackagesService {
  private readonly logger = new Logger(PtPackagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(organizationId: string, memberId?: string) {
    const packages = await this.prisma.ptPackage.findMany({
      where: { organizationId, ...(memberId ? { memberId } : {}) },
      orderBy: { endDate: 'asc' },
    });
    return packages.map(withRemaining);
  }

  async getOne(organizationId: string, id: string) {
    const pkg = await this.prisma.ptPackage.findFirst({
      where: { id, organizationId },
    });
    if (!pkg) throw new NotFoundException('PT package not found');
    return withRemaining(pkg);
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
      const template = await this.prisma.ptPackageTemplate.findFirst({
        where: {
          id: dto.templateId,
          organizationId,
          isActive: true,
        },
        select: { id: true },
      });
      if (!template)
        throw new BadRequestException(
          'Package template not found or inactive in this organization',
        );
    }

    const created = await this.prisma.ptPackage.create({
      data: {
        organizationId,
        branchId: dto.branchId,
        memberId: dto.memberId,
        templateId: dto.templateId ?? null,
        name: dto.name,
        totalSessions: dto.totalSessions,
        startDate,
        endDate,
        price: dto.price,
        currency: dto.currency ?? 'USD',
        status: 'ACTIVE',
      },
    });
    await this.audit.record({
      organizationId,
      actorUserId: createdByUserId,
      action: 'CREATE',
      resource: 'PT_PACKAGE',
      resourceId: created.id,
      afterState: {
        memberId: dto.memberId,
        branchId: dto.branchId,
        totalSessions: dto.totalSessions,
      },
    });
    return this.getOne(organizationId, created.id);
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
    const existing = await tx.ptSessionConsumption.findFirst({
      where: { organizationId, ptSessionId },
    });
    if (existing)
      return {
        consumed: false,
        packageId: existing.packageId ?? null,
        alreadyConsumed: true,
      };

    // Prisma cannot express "usedSessions < totalSessions" as a
    // column-to-column filter, so fetch time-eligible candidates in
    // expiry order and pick the first one with remaining capacity --
    // the same row the old `... AND "usedSessions" < "totalSessions"
    // ORDER BY "endDate" ASC, "createdAt" ASC LIMIT 1 ... FOR UPDATE`
    // query would have returned.
    const candidates = await tx.ptPackage.findMany({
      where: {
        organizationId,
        memberId,
        status: 'ACTIVE',
        startDate: { lte: sessionStartTime },
        endDate: { gte: sessionStartTime },
      },
      orderBy: [{ endDate: 'asc' }, { createdAt: 'asc' }],
    });
    const pkg = candidates.find((c) => c.usedSessions < c.totalSessions);
    if (!pkg) {
      return { consumed: false, packageId: null, alreadyConsumed: false };
    }

    // Guard against consuming a package that is no longer ACTIVE (e.g., already COMPLETED by another transaction)
    if (pkg.status && pkg.status !== 'ACTIVE') {
      this.logger.warn(
        `Package ${pkg.id} status is ${pkg.status} – treating as already consumed`,
      );
      return { consumed: false, packageId: pkg.id, alreadyConsumed: true };
    }

    await tx.ptSessionConsumption.create({
      data: {
        organizationId,
        packageId: pkg.id,
        ptSessionId,
        sessions: 1,
      },
    });

    const newUsed = pkg.usedSessions + 1;
    await tx.ptPackage.update({
      where: { id: pkg.id },
      data: {
        usedSessions: { increment: 1 },
        status: newUsed >= pkg.totalSessions ? 'COMPLETED' : pkg.status,
      },
    });

    return { consumed: true, packageId: pkg.id, alreadyConsumed: false };
  }
}
