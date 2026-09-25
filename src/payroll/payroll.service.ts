import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  GenerateCommissionsDto,
  UpsertCommissionRuleDto,
} from './dto/payroll.dto';

/**
 * Trainer commissions: a rule per trainer, applied to completed PT
 * sessions, approved in a pay window.
 *
 * Ported off `$queryRawUnsafe` (B-P0-6). The tables always had Prisma
 * models -- `TrainerCommissionRule`, `TrainerCommission`, `PayrollPeriod`
 * -- so the raw SQL bought nothing and cost the type checker's help, the
 * relations, and (as the first test written against this module showed)
 * correctness: the write endpoints returned the driver's `RETURNING *`
 * array rather than the row, so `POST /payroll/commission-rules` answered
 * `[{…}]` where every other endpoint in this API answers `{…}`.
 *
 * `trainerId` here is a `StaffProfile` id throughout, matching
 * `PtSession.trainer`, not a `User` id.
 */
@Injectable()
export class PayrollService {
  constructor(private readonly prisma: PrismaService) {}

  rules(org: string) {
    return this.prisma.trainerCommissionRule.findMany({
      where: { organizationId: org },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * One rule per (trainer, sessionType). A rule with no `sessionType` is
   * the trainer's catch-all, so the null case has to match the null case
   * rather than being treated as "no filter".
   */
  async upsertRule(org: string, dto: UpsertCommissionRuleDto) {
    const existing = await this.prisma.trainerCommissionRule.findFirst({
      where: {
        organizationId: org,
        trainerId: dto.trainerId,
        sessionType: dto.sessionType ?? null,
      },
      select: { id: true },
    });

    if (existing) return this.updateRule(org, existing.id, dto);

    return this.prisma.trainerCommissionRule.create({
      data: {
        organizationId: org,
        trainerId: dto.trainerId,
        percentage: dto.percentage,
        fixedAmount: dto.fixedAmount ?? 0,
        sessionType: dto.sessionType ?? null,
      },
    });
  }

  async updateRule(
    org: string,
    id: string,
    dto: Partial<UpsertCommissionRuleDto>,
  ) {
    // Scoped by organization as well as id, so a rule id from another
    // tenant is a 404 rather than an edit.
    const { count } = await this.prisma.trainerCommissionRule.updateMany({
      where: { id, organizationId: org },
      data: {
        ...(dto.percentage !== undefined ? { percentage: dto.percentage } : {}),
        ...(dto.fixedAmount !== undefined
          ? { fixedAmount: dto.fixedAmount }
          : {}),
        ...(dto.sessionType !== undefined
          ? { sessionType: dto.sessionType }
          : {}),
      },
    });
    if (count === 0) throw new NotFoundException('Commission rule not found');

    return this.prisma.trainerCommissionRule.findFirstOrThrow({
      where: { id, organizationId: org },
    });
  }

  async commissions(
    org: string,
    from?: string,
    to?: string,
    trainerId?: string,
  ) {
    const rows = await this.prisma.trainerCommission.findMany({
      where: {
        organizationId: org,
        ...(from || to
          ? {
              sessionAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lt: new Date(to) } : {}),
              },
            }
          : {}),
        ...(trainerId ? { trainerId } : {}),
      },
      orderBy: { sessionAt: 'desc' },
    });

    // The raw version joined staff_profiles -> users for a display name.
    // `TrainerCommission.trainerId` carries no relation, so resolve the
    // names in one query rather than N.
    const nameById = await this.trainerNames(rows.map((r) => r.trainerId));

    return rows.map((row) => ({
      ...row,
      trainerName: nameById.get(row.trainerId) ?? null,
    }));
  }

  async generateCommissions(org: string, dto: GenerateCommissionsDto) {
    const sessions = await this.prisma.ptSession.findMany({
      where: {
        organizationId: org,
        status: 'COMPLETED',
        trainerId: { not: null },
        startTime: { gte: new Date(dto.from), lt: new Date(dto.to) },
      },
      select: {
        id: true,
        trainerId: true,
        startTime: true,
        price: true,
        type: true,
      },
    });

    let created = 0;
    for (const session of sessions) {
      const trainerId = session.trainerId as string;

      // A rule naming this session's type wins over the trainer's
      // catch-all, which is what the old `ORDER BY CASE WHEN` encoded.
      const rules = await this.prisma.trainerCommissionRule.findMany({
        where: {
          organizationId: org,
          trainerId,
          OR: [{ sessionType: session.type }, { sessionType: null }],
        },
      });
      const rule =
        rules.find((r) => r.sessionType === session.type) ??
        rules.find((r) => r.sessionType === null);
      if (!rule) continue;

      const base = new Prisma.Decimal(session.price ?? 0);
      const amount = base
        .mul(rule.percentage)
        .div(100)
        .add(rule.fixedAmount ?? 0);

      // The unique index on (organizationId, ptSessionId) is what actually
      // prevents paying a session twice; `skipDuplicates` leans on it
      // rather than on a read-then-write that two runs could interleave.
      const result = await this.prisma.trainerCommission.createMany({
        data: [
          {
            organizationId: org,
            trainerId,
            ptSessionId: session.id,
            sessionAt: session.startTime,
            baseAmount: base,
            rate: rule.percentage,
            commissionAmount: amount,
          },
        ],
        skipDuplicates: true,
      });
      created += result.count;
    }

    return { scanned: sessions.length, created };
  }

  /**
   * Totals per trainer for a pay window.
   *
   * Carries `trainerName` for the same reason `commissions()` does: the
   * id is a `StaffProfile` id with no relation on `TrainerCommission`, so
   * a caller that wants a name has no way to get one without a second
   * round trip per row. Returning it here keeps the two endpoints the
   * same shape rather than making the caller join one and not the other.
   */
  async summary(org: string, from?: string, to?: string) {
    const grouped = await this.prisma.trainerCommission.groupBy({
      by: ['trainerId'],
      where: {
        organizationId: org,
        ...(from || to
          ? {
              sessionAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lt: new Date(to) } : {}),
              },
            }
          : {}),
      },
      _sum: { baseAmount: true, commissionAmount: true },
      _count: { _all: true },
    });

    const nameById = await this.trainerNames(grouped.map((g) => g.trainerId));

    return grouped
      .map((g) => ({
        trainerId: g.trainerId,
        trainerName: nameById.get(g.trainerId) ?? null,
        baseAmount: g._sum.baseAmount ?? new Prisma.Decimal(0),
        commissionAmount: g._sum.commissionAmount ?? new Prisma.Decimal(0),
        sessions: g._count._all,
      }))
      .sort((a, b) => b.commissionAmount.comparedTo(a.commissionAmount));
  }

  /** One query for the display names behind a set of StaffProfile ids. */
  private async trainerNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const profiles = await this.prisma.staffProfile.findMany({
      where: { id: { in: unique } },
      select: {
        id: true,
        user: { select: { firstName: true, lastName: true } },
      },
    });
    return new Map(
      profiles.map((p) => [p.id, `${p.user.firstName} ${p.user.lastName}`]),
    );
  }
}
