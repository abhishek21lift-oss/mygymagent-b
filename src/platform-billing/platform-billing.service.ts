import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

type LimitKey =
  | 'members'
  | 'branches'
  | 'staff'
  | 'aiMonthlyRequests'
  | 'storageMb'
  | 'whatsappMonthly'
  | 'apiMonthlyCalls';

@Injectable()
export class PlatformBillingService {
  constructor(private readonly prisma: PrismaService) {}

  plans() {
    return this.prisma.$queryRawUnsafe(
      `SELECT * FROM subscription_plans WHERE "isActive"=true ORDER BY "sortOrder" ASC`,
    );
  }

  async subscription(org: string) {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT s.*,p."key" AS "planKey",p.name AS "planName",p."maxMembers",p."maxBranches",p."maxStaff",p."aiMonthlyRequests",p."storageMb",p."whatsappMonthly",p."apiMonthlyCalls"
       FROM organization_subscriptions s
       JOIN subscription_plans p ON p.id=s."planId"
       WHERE s."organizationId"=$1 LIMIT 1`,
      org,
    );
    return rows[0] ?? null;
  }

  async subscribe(org: string, planKey: string) {
    const plan = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM subscription_plans WHERE "key"=$1 AND "isActive"=true LIMIT 1`,
      planKey,
    );
    if (!plan[0]) {
      throw new NotFoundException('Subscription plan not found');
    }

    return this.prisma.$queryRawUnsafe(
      `INSERT INTO organization_subscriptions (id,"organizationId","planId","status","currentPeriodStart","currentPeriodEnd","createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,'ACTIVE',CURRENT_DATE,(CURRENT_DATE + INTERVAL '1 month'),now(),now())
       ON CONFLICT ("organizationId") DO UPDATE SET
         "planId"=EXCLUDED."planId",
         "status"='ACTIVE',
         "currentPeriodStart"=CURRENT_DATE,
         "currentPeriodEnd"=(CURRENT_DATE + INTERVAL '1 month'),
         "updatedAt"=now()
       RETURNING *`,
      org,
      plan[0].id,
    );
  }

  async usage(org: string) {
    const [members, branches, staff] = await Promise.all([
      this.prisma.$queryRawUnsafe<any[]>(
        `SELECT count(*)::int AS count FROM members WHERE "organizationId"=$1 AND "deletedAt" IS NULL`,
        org,
      ),
      this.prisma.$queryRawUnsafe<any[]>(
        `SELECT count(*)::int AS count FROM branches WHERE "organizationId"=$1 AND "deletedAt" IS NULL`,
        org,
      ),
      this.prisma.$queryRawUnsafe<any[]>(
        `SELECT count(*)::int AS count FROM users WHERE "organizationId"=$1 AND "deletedAt" IS NULL`,
        org,
      ),
    ]);

    const sub = await this.subscription(org);
    return {
      plan: sub,
      usage: {
        members: members[0]?.count ?? 0,
        branches: branches[0]?.count ?? 0,
        staff: staff[0]?.count ?? 0,
      },
    };
  }

  invoices(org: string) {
    return this.prisma.$queryRawUnsafe(
      `SELECT * FROM platform_invoices WHERE "organizationId"=$1 ORDER BY "periodStart" DESC`,
      org,
    );
  }

  /**
   * Server-side subscription limit enforcement.
   *
   * A null limit means unlimited. If an organization has no subscription
   * record yet, this method deliberately allows the operation for backwards
   * compatibility with existing tenants; once a tenant has a subscription,
   * limits are authoritative and enforced here rather than in the UI.
   */
  async assertUnder(org: string, key: LimitKey, requested = 1): Promise<void> {
    if (!Number.isInteger(requested) || requested < 1) {
      throw new ForbiddenException('Invalid subscription usage request');
    }

    const sub = await this.subscription(org);
    if (!sub || sub.status !== 'ACTIVE') return;

    const rawLimit = sub[
      key === 'members'
        ? 'maxMembers'
        : key === 'branches'
          ? 'maxBranches'
          : key === 'staff'
            ? 'maxStaff'
            : key
    ];
    if (rawLimit === null || rawLimit === undefined) return;

    const limit = Number(rawLimit);
    if (!Number.isFinite(limit)) return;

    let current = 0;
    if (key === 'members') {
      const rows = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT count(*)::int AS count FROM members WHERE "organizationId"=$1 AND "deletedAt" IS NULL`,
        org,
      );
      current = Number(rows[0]?.count ?? 0);
    } else if (key === 'branches') {
      const rows = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT count(*)::int AS count FROM branches WHERE "organizationId"=$1 AND "deletedAt" IS NULL`,
        org,
      );
      current = Number(rows[0]?.count ?? 0);
    } else if (key === 'staff') {
      const rows = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT count(*)::int AS count FROM users WHERE "organizationId"=$1 AND "deletedAt" IS NULL`,
        org,
      );
      current = Number(rows[0]?.count ?? 0);
    } else if (key === 'aiMonthlyRequests') {
      const rows = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT count(*)::int AS count
         FROM ai_usage_logs
         WHERE "organizationId"=$1
           AND "createdAt" >= date_trunc('month', CURRENT_TIMESTAMP)`,
        org,
      );
      current = Number(rows[0]?.count ?? 0);
    } else {
      // These counters require provider/byte instrumentation that is not
      // represented by a single authoritative table yet. Never invent a
      // number: leave the limit unenforced until a real usage ledger exists.
      return;
    }

    if (current + requested > limit) {
      throw new ForbiddenException(
        `Subscription limit reached for ${key}: ${current}/${limit} used; requested ${requested} more.`,
      );
    }
  }

  async assertCanCreateMembers(org: string, requested: number): Promise<void> {
    return this.assertUnder(org, 'members', requested);
  }
}
