import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PlatformBillingService {
  constructor(private readonly prisma: PrismaService) {}

  plans() { return this.prisma.$queryRawUnsafe(`SELECT * FROM subscription_plans WHERE "isActive"=true ORDER BY "sortOrder" ASC`); }

  async subscription(org: string) {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(`SELECT s.*,p."key" AS "planKey",p.name AS "planName",p."maxMembers",p."maxBranches",p."maxStaff",p."aiMonthlyRequests",p."storageMb",p."whatsappMonthly",p."apiMonthlyCalls" FROM organization_subscriptions s JOIN subscription_plans p ON p.id=s."planId" WHERE s."organizationId"=$1 LIMIT 1`, org);
    return rows[0] ?? null;
  }

  async subscribe(org: string, planKey: string) {
    const plan = await this.prisma.$queryRawUnsafe<any[]>(`SELECT * FROM subscription_plans WHERE "key"=$1 AND "isActive"=true LIMIT 1`, planKey);
    if (!plan[0]) throw new NotFoundException('Subscription plan not found');
    return this.prisma.$queryRawUnsafe(`INSERT INTO organization_subscriptions (id,"organizationId","planId","status","currentPeriodStart","currentPeriodEnd","createdAt","updatedAt") VALUES (gen_random_uuid(),$1,$2,'ACTIVE',CURRENT_DATE,(CURRENT_DATE + INTERVAL '1 month'),now(),now()) ON CONFLICT ("organizationId") DO UPDATE SET "planId"=EXCLUDED."planId","status"='ACTIVE',"currentPeriodStart"=CURRENT_DATE,"currentPeriodEnd"=(CURRENT_DATE + INTERVAL '1 month'),"updatedAt"=now() RETURNING *`, org, plan[0].id);
  }

  async usage(org: string) {
    const [members, branches, staff] = await Promise.all([
      this.prisma.$queryRawUnsafe<any[]>(`SELECT count(*)::int AS count FROM members WHERE "organizationId"=$1 AND COALESCE("deletedAt",NULL) IS NULL`, org),
      this.prisma.$queryRawUnsafe<any[]>(`SELECT count(*)::int AS count FROM branches WHERE "organizationId"=$1 AND COALESCE("deletedAt",NULL) IS NULL`, org),
      this.prisma.$queryRawUnsafe<any[]>(`SELECT count(*)::int AS count FROM users WHERE "organizationId"=$1 AND COALESCE("deletedAt",NULL) IS NULL`, org),
    ]);
    const sub = await this.subscription(org);
    return { plan: sub, usage: { members: members[0]?.count ?? 0, branches: branches[0]?.count ?? 0, staff: staff[0]?.count ?? 0 } };
  }

  invoices(org: string) { return this.prisma.$queryRawUnsafe(`SELECT * FROM platform_invoices WHERE "organizationId"=$1 ORDER BY "periodStart" DESC`, org); }
}
