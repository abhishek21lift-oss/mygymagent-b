/* eslint-disable prettier/prettier */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type CommunicationChannel } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AttendanceService } from '../attendance/attendance.service';
import { CommunicationsService } from '../communications/communications.service';
import { PublicRateLimitService } from '../common/rate-limit/public-rate-limit.service';
import { AuditService } from '../audit/audit.service';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const s = (v: unknown, fallback = '') =>
  typeof v === 'string' && v.trim() ? v.trim() : fallback;
const n = (v: unknown, fallback = 0) =>
  Number.isFinite(Number(v)) ? Number(v) : fallback;

const loyaltyTier = (points: number) =>
  points >= 5000
    ? 'PLATINUM'
    : points >= 2000
      ? 'GOLD'
      : points >= 500
        ? 'SILVER'
        : 'STANDARD';

@Injectable()
export class BusinessOsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attendance: AttendanceService,
    private readonly communications: CommunicationsService,
    private readonly audit: AuditService,
    private readonly rateLimit: PublicRateLimitService,
  ) {}

  async loyaltyAccount(org: string, memberId: string) {
    await this.ensureMember(org, memberId);
    return this.prisma.loyaltyAccount.upsert({
      where: { organizationId_memberId: { organizationId: org, memberId } },
      update: {},
      create: { organizationId: org, memberId },
    });
  }

  private async ensureMember(org: string, memberId: string) {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, organizationId: org, deletedAt: null },
      select: { id: true, primaryBranchId: true },
    });
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }

  private async ensureBranch(org: string, branchId: string) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, organizationId: org, deletedAt: null },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  /**
   * Row-locks the loyalty account (same pattern as AI-4) before reading its
   * current point total, so two concurrent adjustments (e.g. a manual
   * adjust racing a referral-conversion reward) can't both compute from the
   * same pre-adjustment total and lose one delta.
   */
  private async creditLoyaltyPoints(
    tx: Prisma.TransactionClient,
    org: string,
    memberId: string,
    delta: number,
    reason: string,
    referenceType?: string,
    referenceId?: string,
  ) {
    await tx.loyaltyAccount.upsert({
      where: { organizationId_memberId: { organizationId: org, memberId } },
      update: {},
      create: { organizationId: org, memberId },
    });
    await tx.$queryRaw`SELECT id FROM loyalty_accounts WHERE "organization_id" = ${org} AND "member_id" = ${memberId} FOR UPDATE`;
    const account = await tx.loyaltyAccount.findUniqueOrThrow({
      where: { organizationId_memberId: { organizationId: org, memberId } },
    });
    const points = Math.max(account.points + delta, 0);
    const updated = await tx.loyaltyAccount.update({
      where: { id: account.id },
      data: { points, tier: loyaltyTier(points) },
    });
    await tx.loyaltyLedgerEntry.create({
      data: { organizationId: org, memberId, points: delta, reason, referenceType, referenceId },
    });
    return updated;
  }

  async loyaltyAdjust(
    org: string, userId: string, memberId: string, points: number, reason: string,
  ) {
    if (!Number.isInteger(points) || points === 0) throw new BadRequestException('points must be a non-zero integer');
    await this.ensureMember(org, memberId);
    const updated = await this.prisma.$transaction((tx) =>
      this.creditLoyaltyPoints(tx, org, memberId, points, s(reason, 'Manual adjustment')),
    );
    await this.audit.record({ organizationId: org, actorUserId: userId, action: 'LOYALTY_ADJUST', resource: 'loyalty_account', resourceId: memberId, afterState: { points, reason } });
    return updated;
  }

  async createReferral(org: string, referrerId: string) {
    await this.ensureMember(org, referrerId);
    const code = 'REF-' + randomBytes(5).toString('hex').toUpperCase();
    await this.prisma.referral.create({
      data: { organizationId: org, referrerMemberId: referrerId, code },
    });
    return { code };
  }

  async convertReferral(org: string, id: string, referredMemberId: string) {
    await this.ensureMember(org, referredMemberId);
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.referral.updateMany({
        where: { id, organizationId: org, status: 'PENDING' },
        data: { referredMemberId, status: 'CONVERTED', convertedAt: new Date() },
      });
      if (result.count === 0) throw new NotFoundException('Referral not found or already converted');
      const referral = await tx.referral.findFirstOrThrow({ where: { id, organizationId: org } });
      if (referral.rewardPoints > 0) {
        await this.creditLoyaltyPoints(tx, org, referral.referrerMemberId, referral.rewardPoints, 'Referral conversion', 'REFERRAL', id);
      }
      return referral;
    });
  }

  async referrals(org: string) {
    const rows = await this.prisma.referral.findMany({
      where: { organizationId: org },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const referrers = await this.prisma.member.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.referrerMemberId))] } },
      select: { id: true, firstName: true, lastName: true },
    });
    const byId = new Map(referrers.map((m) => [m.id, m]));
    return rows.map((r) => ({
      ...r,
      referrerFirstName: byId.get(r.referrerMemberId)?.firstName ?? null,
      referrerLastName: byId.get(r.referrerMemberId)?.lastName ?? null,
    }));
  }

  tickets(org: string, status?: string) {
    return this.prisma.supportTicket.findMany({
      where: { organizationId: org, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
  async createTicket(org: string, userId: string, b: any) {
    const subject = s(b.subject);
    const description = s(b.description);
    if (!subject || !description)
      throw new BadRequestException('subject and description are required');
    const branchId = b.branchId ? String(b.branchId) : null;
    const memberId = b.memberId ? String(b.memberId) : null;
    if (branchId) await this.ensureBranch(org, branchId);
    if (memberId) {
      const member = await this.ensureMember(org, memberId);
      if (branchId && member.primaryBranchId !== branchId) throw new BadRequestException('Member does not belong to the selected branch');
    }
    return this.prisma.supportTicket.create({
      data: {
        organizationId: org,
        branchId,
        memberId,
        createdByUserId: userId,
        subject,
        description,
        category: s(b.category, 'GENERAL'),
        priority: s(b.priority, 'NORMAL'),
      },
    });
  }
  async addTicketMessage(
    org: string,
    userId: string,
    id: string,
    body: string,
  ) {
    const ticket = await this.prisma.supportTicket.findFirst({ where: { id, organizationId: org }, select: { id: true } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (!s(body)) throw new BadRequestException('body is required');
    return this.prisma.supportTicketMessage.create({
      data: { organizationId: org, ticketId: id, authorUserId: userId, body },
    });
  }
  async updateTicket(org: string, id: string, status: string) {
    if (
      !['OPEN', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED'].includes(status)
    )
      throw new BadRequestException('Invalid ticket status');
    const existing = await this.prisma.supportTicket.findFirst({ where: { id, organizationId: org }, select: { resolvedAt: true } });
    if (!existing) throw new NotFoundException('Ticket not found');
    // Preserves the first resolution timestamp across a later RESOLVED<->CLOSED
    // transition, matching the original SQL's COALESCE(resolved_at, now()).
    const resolvedAt = ['RESOLVED', 'CLOSED'].includes(status) ? (existing.resolvedAt ?? new Date()) : null;
    return this.prisma.supportTicket.update({ where: { id }, data: { status, resolvedAt } });
  }

  surveys(org: string) {
    return this.prisma.feedbackSurvey.findMany({
      where: { organizationId: org },
      orderBy: { createdAt: 'desc' },
    });
  }
  createSurvey(org: string, b: any) {
    const name = s(b.name);
    if (!name) throw new BadRequestException('name is required');
    return this.prisma.feedbackSurvey.create({
      data: { organizationId: org, name, kind: s(b.kind, 'CSAT') },
    });
  }
  async respondFeedback(org: string, b: any) {
    if (!b.surveyId || !b.memberId)
      throw new BadRequestException('surveyId and memberId are required');
    const score = n(b.score, -1);
    if (score < 0 || score > 10)
      throw new BadRequestException('score must be 0-10');
    const survey = await this.prisma.feedbackSurvey.findFirst({
      where: { id: String(b.surveyId), organizationId: org, active: true },
      select: { id: true },
    });
    if (!survey) throw new NotFoundException('Survey not found');
    await this.ensureMember(org, String(b.memberId));
    return this.prisma.feedbackResponse.create({
      data: {
        organizationId: org,
        surveyId: String(b.surveyId),
        memberId: String(b.memberId),
        score,
        comment: s(b.comment) || null,
      },
    });
  }
  async feedbackSummary(org: string) {
    const rows = await this.prisma.feedbackResponse.findMany({
      where: { organizationId: org },
      select: { surveyId: true, score: true },
    });
    const bySurvey = new Map<string, number[]>();
    for (const r of rows) bySurvey.set(r.surveyId, [...(bySurvey.get(r.surveyId) ?? []), r.score]);
    return [...bySurvey.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([surveyId, scores]) => {
        const responses = scores.length;
        const promoters = scores.filter((sc) => sc >= 9).length;
        const detractors = scores.filter((sc) => sc <= 6).length;
        const round2 = (v: number) => Math.round(v * 100) / 100;
        return {
          surveyId,
          responses,
          avgScore: round2(scores.reduce((a, b) => a + b, 0) / responses),
          promoters,
          detractors,
          nps: round2((100 * promoters) / responses - (100 * detractors) / responses),
        };
      });
  }
  async ptIntelligence(org: string, memberId: string) {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, organizationId: org, deletedAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        assignedTrainerId: true,
      },
    });
    if (!member) throw new NotFoundException('Member not found');
    const [attendance, workouts, ptSessions] = await Promise.all([
      this.prisma.attendance.count({
        where: { organizationId: org, memberId, deniedReason: null },
      }),
      this.prisma.workoutSession.count({
        where: { organizationId: org, memberId },
      }),
      this.prisma.ptSession.count({
        where: { organizationId: org, memberId, status: 'COMPLETED' },
      }),
    ]);
    const last = await this.prisma.attendance.findFirst({
      where: { organizationId: org, memberId },
      orderBy: { checkInAt: 'desc' },
      select: { checkInAt: true },
    });
    const daysSince = last
      ? Math.max(
          0,
          Math.floor((Date.now() - last.checkInAt.getTime()) / 86400000),
        )
      : null;
    return {
      member,
      attendanceCount: attendance,
      workoutSessionCount: workouts,
      completedPtSessions: ptSessions,
      lastCheckInAt: last?.checkInAt ?? null,
      daysSinceLastCheckIn: daysSince,
      engagementBand:
        daysSince === null
          ? 'NO_DATA'
          : daysSince <= 3
            ? 'HIGH'
            : daysSince <= 10
              ? 'MEDIUM'
              : 'LOW',
    };
  }
  async accountingJournal(org: string, userId: string, b: any) {
    const lines: Array<{ accountId: string; debit?: unknown; credit?: unknown; branchId?: string; description?: string }> = Array.isArray(b.lines) ? b.lines : [];
    if (lines.length < 2) throw new BadRequestException('at least two journal lines are required');
    const debit = lines.reduce((a, l) => a + n(l.debit), 0);
    const credit = lines.reduce((a, l) => a + n(l.credit), 0);
    if (Math.abs(debit - credit) > 0.005) throw new BadRequestException('journal is not balanced');
    return this.prisma.$transaction(async (tx) => {
      const created: Prisma.AccountingEntryGetPayload<object>[] = [];
      for (const l of lines) {
        const d = n(l.debit), cr = n(l.credit);
        if ((d <= 0 && cr <= 0) || (d > 0 && cr > 0)) throw new BadRequestException('each journal line must have exactly one positive side');
        const account = await tx.accountingAccount.findFirst({ where: { id: l.accountId, organizationId: org, active: true }, select: { id: true } });
        if (!account) throw new NotFoundException('Accounting account not found');
        if (l.branchId) await this.ensureBranch(org, l.branchId);
        created.push(
          await tx.accountingEntry.create({
            data: {
              organizationId: org,
              accountId: l.accountId,
              branchId: l.branchId ?? null,
              referenceType: b.referenceType ?? null,
              referenceId: b.referenceId ?? null,
              debit: d,
              credit: cr,
              description: s(l.description, 'Journal entry'),
              entryDate: b.entryDate ? new Date(b.entryDate) : new Date(),
            },
          }),
        );
      }
      await this.audit.record({ organizationId: org, actorUserId: userId, action: 'ACCOUNTING_JOURNAL_CREATE', resource: 'accounting_journal', afterState: { lines: created } });
      return created;
    });
  }
  private entryDateRange(from?: string, to?: string) {
    if (!from && !to) return undefined;
    return { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) };
  }
  async taxSummary(org: string, from?: string, to?: string) {
    const agg = await this.prisma.accountingEntry.aggregate({
      where: { organizationId: org, ...(this.entryDateRange(from, to) ? { entryDate: this.entryDateRange(from, to) } : {}) },
      _sum: { debit: true, credit: true },
    });
    const totalDebit = agg._sum.debit ?? new Prisma.Decimal(0);
    const totalCredit = agg._sum.credit ?? new Prisma.Decimal(0);
    return [{
      totalDebit: totalDebit.toNumber(),
      totalCredit: totalCredit.toNumber(),
      net: totalDebit.minus(totalCredit).toNumber(),
    }];
  }

  campaigns(org: string) {
    return this.prisma.marketingCampaign.findMany({
      where: { organizationId: org },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }
  async createCampaign(org: string, b: any) {
    const name = s(b.name);
    if (!name) throw new BadRequestException('name is required');
    const channel = s(b.channel, 'EMAIL');
    if (!['EMAIL', 'WHATSAPP', 'SMS'].includes(channel)) throw new BadRequestException('channel must be EMAIL, WHATSAPP or SMS');
    if (b.branchId) await this.ensureBranch(org, String(b.branchId));
    const audienceFilter = b.audienceFilter && typeof b.audienceFilter === 'object' ? b.audienceFilter : {};
    return this.prisma.marketingCampaign.create({
      data: {
        organizationId: org,
        branchId: b.branchId ?? null,
        name,
        channel,
        templateKey: s(b.templateKey) || null,
        audienceFilter,
        status: 'DRAFT',
        scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : null,
      },
    });
  }
  /**
   * Builds the audience purely through Prisma's typed query builder (Member/
   * Membership/Attendance are all real, related Prisma models already —
   * this never needed raw SQL). The pre-B-P0-1 version used
   * `$queryRawUnsafe` with unquoted snake_case column references
   * (`m.organization_id`, `m.primary_branch_id`, `ms.end_date`, ...) against
   * tables whose actual columns are quoted camelCase (`"organizationId"`,
   * `"primaryBranchId"`, ...) — every call would have thrown a Postgres
   * "column does not exist" error, so this endpoint never actually worked.
   * Also fixes `maxDaysSinceCheckIn`: the old SQL OR'd in "never attended"
   * on *both* the min and max branches (a copy-paste bug), which would have
   * made a "recently active" filter also match members with zero attendance
   * history once the column-name bug above was fixed.
   */
  async enrollCampaign(org: string, id: string) {
    const camp = await this.prisma.marketingCampaign.findFirst({ where: { id, organizationId: org } });
    if (!camp) throw new NotFoundException('Campaign not found');
    const filter = (
      camp.audienceFilter && typeof camp.audienceFilter === 'object' && !Array.isArray(camp.audienceFilter)
        ? (camp.audienceFilter as Record<string, unknown>)
        : {}
    );
    const allowed = new Set(['branchId','status','memberType','leadSource','assignedTrainerId','hasActiveMembership','minDaysSinceCheckIn','maxDaysSinceCheckIn','hasEmail','hasPhone']);
    for (const key of Object.keys(filter)) if (!allowed.has(key)) throw new BadRequestException('Unsupported audience filter: '+key);

    const where: Prisma.MemberWhereInput = { organizationId: org, deletedAt: null };
    const and: Prisma.MemberWhereInput[] = [];
    if (filter.branchId) { await this.ensureBranch(org, String(filter.branchId)); where.primaryBranchId = String(filter.branchId); }
    if (filter.status) where.status = String(filter.status) as any;
    if (filter.memberType) where.memberType = String(filter.memberType) as any;
    if (filter.leadSource) where.leadSource = String(filter.leadSource);
    if (filter.assignedTrainerId) {
      const trainer = await this.prisma.user.findFirst({ where: { id: String(filter.assignedTrainerId), organizationId: org, deletedAt: null }, select: { id: true } });
      if (!trainer) throw new NotFoundException('Trainer not found');
      where.assignedTrainerId = String(filter.assignedTrainerId);
    }
    if (filter.hasEmail === true) and.push({ email: { not: null }, NOT: { email: '' } });
    if (filter.hasPhone === true) and.push({ phone: { not: null }, NOT: { phone: '' } });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (filter.hasActiveMembership === true) and.push({ memberships: { some: { status: 'ACTIVE', endDate: { gte: today } } } });
    if (filter.hasActiveMembership === false) and.push({ memberships: { none: { status: 'ACTIVE', endDate: { gte: today } } } });
    if (filter.minDaysSinceCheckIn !== undefined) {
      const min = Number(filter.minDaysSinceCheckIn);
      if (!Number.isInteger(min) || min < 0) throw new BadRequestException('minDaysSinceCheckIn must be a non-negative integer');
      const cutoff = new Date(Date.now() - min * 86400000);
      and.push({ attendances: { none: { checkInAt: { gt: cutoff } } } });
    }
    if (filter.maxDaysSinceCheckIn !== undefined) {
      const max = Number(filter.maxDaysSinceCheckIn);
      if (!Number.isInteger(max) || max < 0) throw new BadRequestException('maxDaysSinceCheckIn must be a non-negative integer');
      const cutoff = new Date(Date.now() - max * 86400000);
      and.push({ attendances: { some: { checkInAt: { gte: cutoff } } } });
    }
    if (and.length > 0) where.AND = and;

    const members = await this.prisma.member.findMany({
      where,
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: 5000,
    });
    for (const m of members) {
      await this.prisma.marketingCampaignMember.upsert({
        where: { campaignId_memberId: { campaignId: id, memberId: m.id } },
        update: {},
        create: { organizationId: org, campaignId: id, memberId: m.id },
      });
    }
    await this.prisma.marketingCampaign.updateMany({
      where: { id, organizationId: org, status: { in: ['DRAFT', 'QUEUED', 'RUNNING'] } },
      data: { status: 'QUEUED' },
    });
    return { enrolled: members.length, audienceFilter: filter };
  }
  async runCampaign(org: string, id: string) {
    const camp = await this.prisma.marketingCampaign.findFirst({ where: { id, organizationId: org } });
    if (!camp) throw new NotFoundException('Campaign not found');
    const queued = await this.prisma.marketingCampaignMember.findMany({
      where: { campaignId: id, organizationId: org, status: 'QUEUED' },
      take: 500,
    });
    const members = await this.prisma.member.findMany({
      where: { id: { in: queued.map((q) => q.memberId) } },
      select: { id: true, phone: true, email: true },
    });
    const byId = new Map(members.map((m) => [m.id, m]));
    let sent = 0, failed = 0;
    for (const q of queued) {
      const member = byId.get(q.memberId);
      // `camp.channel` is a plain, unvalidated-at-write-time String column
      // (see MarketingCampaign in schema.prisma), so this allowlist check is
      // load-bearing, not decorative -- it's what makes the cast below safe.
      const channel = (['WHATSAPP', 'SMS', 'EMAIL'].includes(camp.channel) ? camp.channel : 'EMAIL') as CommunicationChannel;
      const recipient = channel === 'WHATSAPP' || channel === 'SMS' ? member?.phone : member?.email;
      if (!recipient) {
        failed++;
        await this.prisma.marketingCampaignMember.updateMany({ where: { campaignId: id, memberId: q.memberId, status: 'QUEUED' }, data: { status: 'FAILED', error: 'Missing recipient address' } });
        continue;
      }
      try {
        await this.communications.sendAdHoc({ organizationId: org, channel, category: 'MARKETING', recipient, body: camp.templateKey ?? camp.name });
        await this.prisma.marketingCampaignMember.updateMany({ where: { campaignId: id, memberId: q.memberId, status: 'QUEUED' }, data: { status: 'SENT', sentAt: new Date(), error: null } });
        sent++;
      } catch (e) {
        failed++;
        await this.prisma.marketingCampaignMember.updateMany({ where: { campaignId: id, memberId: q.memberId, status: 'QUEUED' }, data: { status: 'FAILED', error: e instanceof Error ? e.message : String(e) } });
      }
    }
    const remaining = await this.prisma.marketingCampaignMember.count({ where: { campaignId: id, organizationId: org, status: 'QUEUED' } });
    await this.prisma.marketingCampaign.updateMany({ where: { id, organizationId: org }, data: { status: remaining > 0 ? 'RUNNING' : 'COMPLETED' } });
    return { processed: queued.length, sent, failed };
  }
  accounts(org: string) {
    return this.prisma.accountingAccount.findMany({
      where: { organizationId: org },
      orderBy: { code: 'asc' },
    });
  }
  createAccount(org: string, b: any) {
    const code = s(b.code),
      name = s(b.name),
      type = s(b.type, 'EXPENSE');
    const allowedTypes = new Set(['ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE']);
    if (!code || !name) throw new BadRequestException('code and name are required');
    if (!allowedTypes.has(type)) throw new BadRequestException('Invalid accounting account type');
    return this.prisma.accountingAccount.create({
      data: { organizationId: org, code, name, type },
    });
  }
  async trialBalance(org: string, from?: string, to?: string) {
    const accounts = await this.prisma.accountingAccount.findMany({
      where: { organizationId: org },
      orderBy: { code: 'asc' },
    });
    const range = this.entryDateRange(from, to);
    const sums = await this.prisma.accountingEntry.groupBy({
      by: ['accountId'],
      where: { organizationId: org, ...(range ? { entryDate: range } : {}) },
      _sum: { debit: true, credit: true },
    });
    const byAccount = new Map(sums.map((row) => [row.accountId, row._sum]));
    return accounts.map((a) => {
      const sum = byAccount.get(a.id);
      const debit = sum?.debit ?? new Prisma.Decimal(0);
      const credit = sum?.credit ?? new Prisma.Decimal(0);
      return {
        code: a.code,
        name: a.name,
        type: a.type,
        debit: debit.toNumber(),
        credit: credit.toNumber(),
        balance: debit.minus(credit).toNumber(),
      };
    });
  }

  async createPortalInvite(org: string, userId: string, memberId: string) {
    const member = await this.ensureMember(org, memberId);
    const token = randomBytes(32).toString('hex');
    await this.prisma.$transaction(async (tx) => {
      await tx.portalInvite.updateMany({ where: { organizationId: org, memberId, usedAt: null }, data: { usedAt: new Date() } });
      await tx.portalInvite.create({
        data: { organizationId: org, memberId, tokenHash: hash(token), expiresAt: new Date(Date.now() + 7 * 86400000) },
      });
    });
    await this.audit.record({ organizationId: org, actorUserId: userId, action: 'PORTAL_INVITE_CREATE', resource: 'portal_invite', resourceId: memberId });
    return { token, expiresInDays: 7, member };
  }

  async revokePortalInvites(org: string, userId: string, memberId: string) {
    await this.ensureMember(org, memberId);
    const result = await this.prisma.portalInvite.updateMany({ where: { organizationId: org, memberId, usedAt: null }, data: { usedAt: new Date() } });
    await this.audit.record({ organizationId: org, actorUserId: userId, action: 'PORTAL_INVITE_REVOKE', resource: 'portal_invite', resourceId: memberId });
    return { revoked: result.count };
  }

  async portalBootstrap(token: string, clientKey: string) {
    if (!token || token.length < 32) throw new BadRequestException('Invalid portal token');
    await this.rateLimit.consume('portal-bootstrap', clientKey, 20, 60);
    const invite = await this.prisma.portalInvite.findFirst({
      where: { tokenHash: hash(token), usedAt: null, expiresAt: { gt: new Date() } },
    });
    const member = invite
      ? await this.prisma.member.findFirst({
          where: { id: invite.memberId, deletedAt: null },
          select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        })
      : null;
    if (!invite || !member) throw new NotFoundException('Invalid or expired portal token');
    const consumed = await this.prisma.portalInvite.updateMany({
      where: { id: invite.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) throw new NotFoundException('Invalid or expired portal token');
    const memberships = await this.prisma.membership.findMany({ where: { organizationId: invite.organizationId, memberId: invite.memberId }, orderBy: { endDate: 'desc' }, take: 10 });
    const attendance = await this.prisma.attendance.findMany({ where: { organizationId: invite.organizationId, memberId: invite.memberId }, orderBy: { checkInAt: 'desc' }, take: 20 });
    return { member, memberships, attendance };
  }
}
